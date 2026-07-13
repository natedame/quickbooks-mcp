#!/usr/bin/env node
// Production bank connect + capture (the one-time human click).
//
// Generates a real Associated Bank Hosted Link, prints the URL for Nate to click,
// then polls /link/token/get until the connect completes and captures the durable
// access_token. Read-only on the bank; no money-movement method exists in the
// client by construction. Nothing here touches the live QuickBooks books.
//
// Usage:
//   node scripts/plaid-connect.mjs [--watch-seconds N] [--generate-only]
//
// Exit codes (distinct, for a host driving this via run_in_background/Monitor):
//   0  ✅ CAPTURED        — bank connected, access_token persisted
//   2  ⏳ TIMEOUT_RESUME  — window elapsed, connect not yet done; re-run to resume
//   3  🔗 ALREADY_CONNECTED — an Item already exists (idempotency guard)
//   4  ❌ FAILED          — a real error (bad secret, Plaid error, expired link)
//   5  🔒 LOCKED          — another poller is already running

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// The connect flow is the ONLY path that selects production. config.ts fail-safes
// to sandbox unless PLAID_ENV=production is explicit, so set it before any import
// that reads config.
process.env.PLAID_ENV = "production";

const { PlaidClient } = await import("../dist/plaid/client.js");
const {
  loadItem,
  saveItem,
  loadPendingLink,
  savePendingLink,
  clearPendingLink,
} = await import("../dist/plaid/token-store.js");
const { decideConnectAction } = await import("../dist/plaid/connect-flow.js");

const ENV = "production";
const CLIENT_USER_ID = "profound-strategy-associated-bank";
const URL_LIFETIME_SECONDS = 86400; // 24h — comfortably long enough for a human to click
const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_EVERY_MS = 60000;
const LOCK_PATH = join(homedir(), ".quickbooks-mcp", "plaid-connect.lock");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const WATCH_SECONDS = parseInt(arg("--watch-seconds", "1200"), 10); // default 20m; run bg with a longer window
const GENERATE_ONLY = process.argv.includes("--generate-only");

function log(msg) {
  console.log(`${new Date().toISOString()}  ${msg}`);
}
function fail(msg) {
  log(`❌ FAILED — ${msg}`);
  releaseLock();
  process.exit(4);
}

// ---- single-poller lock (avoid two confusing concurrent pollers) ----
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const old = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
    if (Number.isFinite(old) && pidAlive(old)) {
      log(`🔒 LOCKED — another connect poller is already running (pid ${old}). Exiting.`);
      process.exit(5);
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid), { mode: 0o600 });
}
function releaseLock() {
  try {
    if (existsSync(LOCK_PATH) && readFileSync(LOCK_PATH, "utf-8").trim() === String(process.pid)) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    /* best effort */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plaidErr = (e) => (e?.response?.data ? JSON.stringify(e.response.data) : e?.message || String(e));
const plaidErrCode = (e) => e?.response?.data?.error_code || "";

async function main() {
  acquireLock();
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(2);
  });

  const plaid = new PlaidClient(undefined, ENV);

  const existing = await loadItem(ENV);
  let pending = await loadPendingLink(ENV);
  const action = decideConnectAction(existing, pending, Date.now());

  if (action === "already_connected") {
    const inst = existing.institution_name || existing.institution_id || "your bank";
    log(`🔗 ALREADY_CONNECTED — ${inst} is already connected (item ${existing.item_id}).`);
    log(`   To reconnect a DIFFERENT bank, delete ~/.quickbooks-mcp/plaid-item.${ENV}.json first.`);
    releaseLock();
    process.exit(3);
  }

  if (action === "generate" || action === "regenerate") {
    if (action === "regenerate") {
      log("⚠️  Prior Hosted Link expired before it was used — generating a fresh one.");
      await clearPendingLink(ENV);
    }
    let link;
    try {
      link = await plaid.createHostedLink(CLIENT_USER_ID, { urlLifetimeSeconds: URL_LIFETIME_SECONDS });
    } catch (e) {
      fail(`could not create the Hosted Link (check PLAID_SECRET_PRODUCTION): ${plaidErr(e)}`);
    }
    pending = {
      env: ENV,
      link_token: link.link_token,
      expiration: link.expiration,
      hosted_link_url: link.hosted_link_url,
      created_at: new Date().toISOString(),
    };
    await savePendingLink(pending);
    log("🔗 CONNECT LINK READY — click to connect Associated Bank:");
    log(`   ${pending.hosted_link_url}`);
    log(`   (link valid until ${pending.expiration})`);
    if (GENERATE_ONLY) {
      log("   --generate-only set; not polling. Re-run without it to capture.");
      releaseLock();
      process.exit(0);
    }
  } else {
    log("↩️  Resuming an in-flight connect (a Hosted Link is already pending).");
    log(`   ${pending.hosted_link_url}`);
  }

  // ---- poll for completion ----
  const deadline = Date.now() + WATCH_SECONDS * 1000;
  let lastHeartbeat = 0;
  let exitedNotified = false;
  log(`⏳ Watching for the connect to complete (up to ${Math.round(WATCH_SECONDS / 60)} min this run)…`);

  while (Date.now() < deadline) {
    let result;
    try {
      result = await plaid.getLinkSessionResult(pending.link_token);
    } catch (e) {
      const code = plaidErrCode(e);
      if (code === "INVALID_LINK_TOKEN" || code === "LINK_TOKEN_EXPIRED" || code === "INVALID_FIELD") {
        await clearPendingLink(ENV);
        fail(`the Hosted Link is no longer valid (${code}). Re-run to generate a fresh link.`);
      }
      // Transient (network/5xx) — log once per heartbeat and keep polling.
      if (Date.now() - lastHeartbeat >= HEARTBEAT_EVERY_MS) {
        log(`   …transient error polling, will retry: ${plaidErr(e)}`);
        lastHeartbeat = Date.now();
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (result.publicToken) {
      await capture(plaid, result);
      return; // capture() exits the process
    }

    if (result.exited && !exitedNotified) {
      log("⚠️  A connect attempt was cancelled/exited without finishing. The same link is still");
      log("    valid — click it again to retry. Still watching for a successful connect…");
      exitedNotified = true;
    }

    if (Date.now() - lastHeartbeat >= HEARTBEAT_EVERY_MS) {
      log("   …still waiting for the connect to complete.");
      lastHeartbeat = Date.now();
    }
    await sleep(POLL_INTERVAL_MS);
  }

  log("⏳ TIMEOUT_RESUME — the connect wasn't completed in this window. The link is still");
  log("   valid; re-run this script to resume watching (nothing is lost).");
  releaseLock();
  process.exit(2);
}

async function capture(plaid, result) {
  log("🎉 Connect detected — capturing the durable access token…");
  let exchanged;
  try {
    exchanged = await plaid.exchangePublicToken(result.publicToken);
  } catch (e) {
    fail(`exchanging the public token failed: ${plaidErr(e)}`);
  }

  // Resolve institution name if the session didn't include it (best-effort, non-fatal).
  let institutionId = result.institutionId;
  let institutionName = result.institutionName;
  if (!institutionId) {
    try {
      institutionId = await plaid.getItemInstitutionId(exchanged.access_token);
    } catch {
      /* non-fatal */
    }
  }
  if (institutionId && !institutionName) {
    try {
      institutionName = (await plaid.getInstitution(institutionId)).name;
    } catch {
      /* non-fatal */
    }
  }

  const now = new Date().toISOString();
  await saveItem({
    env: ENV,
    access_token: exchanged.access_token, // stored 0600, never printed
    item_id: exchanged.item_id,
    institution_id: institutionId,
    institution_name: institutionName,
    created_at: now,
    updated_at: now,
  });
  await clearPendingLink(ENV);

  log(`✅ CAPTURED — connected to ${institutionName || institutionId || "your bank"} (item ${exchanged.item_id}).`);
  log("   Access token stored securely (0600); it is never printed or logged.");

  // Proof the real feed reads: pull one sync page and show masked accounts + balances (free with sync).
  try {
    const page = await plaid.syncTransactions(exchanged.access_token);
    const accounts = page.accounts || [];
    log(`   Read ${accounts.length} account(s) from the live feed:`);
    for (const a of accounts) {
      const mask = a.mask ? `…${a.mask}` : "";
      log(`     • ${a.name} ${mask} (${a.subtype || a.type}) — balance ${a.current ?? "n/a"} ${a.iso_currency_code || ""}`);
    }
    log(`   First sync page: ${page.added.length} transaction(s) available.`);
  } catch (e) {
    log(`   (connected fine; first read-back deferred: ${plaidErr(e)})`);
  }

  releaseLock();
  process.exit(0);
}

main().catch((e) => fail(plaidErr(e)));
