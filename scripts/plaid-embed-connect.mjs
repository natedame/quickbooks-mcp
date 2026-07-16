#!/usr/bin/env node
// Embedded Plaid Link connect + capture (the one-time human click) — the sibling
// of scripts/plaid-connect.mjs, built because production HOSTED Link died silently
// on institution-select (empty finished session, on_exit null) with no reportable
// reason. Embedded Link (Plaid Link JS in the user's own browser) fires
// onExit(err, metadata) CLIENT-side, so it surfaces the exact error_code /
// display_message / status that Hosted Link hides — and it runs a different code
// path that may simply succeed where the hosted flow didn't.
//
// It serves a tiny page on 127.0.0.1 (Plaid Link JS accepts an https OR a
// localhost origin, so no cert / tunnel is needed when opened on this Mac), runs
// Link, and on success exchanges the public_token for the durable access_token —
// the same read-only Item the hosted runner would have produced. Read-only on the
// bank; no money-movement method exists in the client by construction. Nothing
// here touches the live QuickBooks books, and it never restarts the running MCP
// server.
//
// Usage:
//   node scripts/plaid-embed-connect.mjs [--port N] [--watch-seconds N]
//
// Exit codes (distinct, for a host driving this via run_in_background/Monitor):
//   0  ✅ CAPTURED          — bank connected, access_token persisted
//   2  ⏳ TIMEOUT           — window elapsed, connect not completed; re-run to retry
//   3  🔗 ALREADY_CONNECTED — an Item already exists (idempotency guard)
//   4  ❌ FAILED            — a real error (bad secret, port in use, Plaid error)
//   5  🔒 LOCKED            — another connect poller/server is already running

import { createServer } from "http";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { join } from "path";

// This is the PRODUCTION connect tool (like scripts/plaid-connect.mjs), so it
// defaults to production. A test may set PLAID_ENV=sandbox explicitly to exercise
// the full flow safely — sandbox and production keep entirely separate item files
// (plaid-item.<env>.json) and credentials, so a sandbox run can never touch the
// real production Item. Set before any import that reads config.
if (!process.env.PLAID_ENV) process.env.PLAID_ENV = "production";

const { PlaidClient } = await import("../dist/plaid/client.js");
const { loadItem, saveItem } = await import("../dist/plaid/token-store.js");

const ENV = process.env.PLAID_ENV === "sandbox" ? "sandbox" : "production";
const CLIENT_USER_ID = "profound-strategy-associated-bank";
// Shared with the hosted runner so the two connect paths are mutually exclusive —
// they must never race to capture/overwrite the same production Item.
const LOCK_PATH = join(homedir(), ".quickbooks-mcp", "plaid-connect.lock");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = parseInt(arg("--port", "8791"), 10);
const WATCH_SECONDS = parseInt(arg("--watch-seconds", "900"), 10); // 15m default — interactive, synchronous

function log(msg) {
  console.log(`${new Date().toISOString()}  ${msg}`);
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
function fail(msg) {
  log(`❌ FAILED — ${msg}`);
  releaseLock();
  process.exit(4);
}
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    const old = parseInt(readFileSync(LOCK_PATH, "utf-8").trim(), 10);
    // Stale-lock reclaim: if the recorded pid is gone, take it over.
    let alive = false;
    try {
      process.kill(old, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      log(`🔒 LOCKED — another connect process (pid ${old}) is already running.`);
      process.exit(5);
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid), { mode: 0o600 });
}

function plaidErr(e) {
  return e?.response?.data?.error_code
    ? `${e.response.data.error_code}: ${e.response.data.error_message}`
    : e?.message || String(e);
}

async function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy(); // bound the body
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// A single per-session nonce: minted here, embedded in the page, and required on
// every POST so nothing else on the machine can drive /capture or /exit.
const NONCE = randomBytes(24).toString("hex");

function page(linkToken) {
  // link_token is a short-lived, single-session client token by Plaid design —
  // safe to embed in the page (unlike the client_id / secret, which stay server
  // side and never reach the browser).
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Associated Bank</title>
<style>
  body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:40px 24px;color:#1a1a1a;background:#f6f7f9}
  .card{max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 26px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  h1{font-size:19px;margin:0 0 6px}
  p{color:#555;line-height:1.5}
  #status{margin-top:16px;padding:14px 16px;border-radius:10px;background:#eef2f7;color:#333;white-space:pre-wrap}
  .ok{background:#e7f6ec !important;color:#146c2e !important}
  .err{background:#fdecec !important;color:#a12020 !important}
  button{margin-top:14px;font-size:16px;padding:11px 20px;border:0;border-radius:9px;background:#2b6cff;color:#fff;cursor:pointer}
</style></head>
<body><div class="card">
  <h1>Connect Associated Bank</h1>
  <p>This opens Plaid securely to link your bank read-only. Nothing is written to your books.</p>
  <div id="status">Opening the secure Plaid window…</div>
  <button id="reopen" style="display:none">Open Plaid again</button>
</div>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
  var S = document.getElementById('status');
  var R = document.getElementById('reopen');
  function post(path, data){ return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({nonce:'${NONCE}'},data))}); }
  var handler = Plaid.create({
    token: ${JSON.stringify(linkToken)},
    onSuccess: function(public_token, metadata){
      S.textContent = 'Connected! Finishing up — you can close this window.';
      S.className = 'ok';
      post('/capture', {
        public_token: public_token,
        institution_id: metadata && metadata.institution ? metadata.institution.institution_id : null,
        institution_name: metadata && metadata.institution ? metadata.institution.name : null
      });
    },
    onExit: function(err, metadata){
      if (err){
        S.textContent = 'Plaid reported: ' + (err.display_message || err.error_message || err.error_code || 'exited') + '\\n(Sent the exact reason back — you can close this and check back.)';
        S.className = 'err';
      } else {
        S.textContent = 'You closed the window before finishing. Tap below to try again.';
      }
      R.style.display = 'inline-block';
      post('/exit', {
        error_code: err && err.error_code, error_type: err && err.error_type,
        display_message: err && err.display_message, error_message: err && err.error_message,
        status: metadata && metadata.status,
        institution_id: metadata && metadata.institution ? metadata.institution.institution_id : null,
        request_id: metadata && metadata.request_id
      });
    }
  });
  R.onclick = function(){ handler.open(); };
  handler.open();
</script>
</body></html>`;
}

async function capturePublicToken(plaid, publicToken, instId, instName) {
  let exchanged;
  try {
    exchanged = await plaid.exchangePublicToken(publicToken);
  } catch (e) {
    fail(`exchanging the public token failed: ${plaidErr(e)}`);
  }
  let institutionId = instId || undefined;
  let institutionName = instName || undefined;
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
  log(`✅ CAPTURED — connected to ${institutionName || institutionId || "your bank"} (item ${exchanged.item_id}).`);
  log("   Access token stored securely (0600); it is never printed or logged.");
  // Proof the real feed reads: pull one sync page and show masked accounts (free with sync).
  try {
    const pageData = await plaid.syncTransactions(exchanged.access_token);
    const accounts = pageData.accounts || [];
    log(`   Read ${accounts.length} account(s) from the live feed:`);
    for (const a of accounts) {
      const mask = a.mask ? `…${a.mask}` : "";
      log(`     • ${a.name} ${mask} (${a.subtype || a.type}) — balance ${a.current ?? "n/a"} ${a.iso_currency_code || ""}`);
    }
    log(`   First sync page: ${pageData.added.length} transaction(s) available.`);
  } catch (e) {
    log(`   (connected fine; first read-back deferred: ${plaidErr(e)})`);
  }
}

async function main() {
  acquireLock();
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(2);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(2);
  });

  // Idempotency guard: never clobber an already-connected production Item.
  const existing = await loadItem(ENV);
  if (existing) {
    const inst = existing.institution_name || existing.institution_id || "your bank";
    log(`🔗 ALREADY_CONNECTED — ${inst} is already connected (item ${existing.item_id}). Nothing to do.`);
    log("   To reconnect, delete ~/.quickbooks-mcp/plaid-item.production.json first.");
    releaseLock();
    process.exit(3);
  }

  const plaid = new PlaidClient(undefined, ENV);
  let linkToken;
  try {
    const t = await plaid.createLinkToken(CLIENT_USER_ID);
    linkToken = t.link_token;
  } catch (e) {
    fail(`creating the embedded link token failed: ${plaidErr(e)}`);
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(linkToken));
        return;
      }
      if (req.method === "POST" && req.url === "/capture") {
        const body = await readJson(req);
        if (body.nonce !== NONCE) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad nonce" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        log("🎉 Connect detected — capturing the durable access token…");
        await capturePublicToken(plaid, body.public_token, body.institution_id, body.institution_name);
        // Shut down immediately after a successful capture; do not linger.
        server.close();
        releaseLock();
        process.exit(0);
      }
      if (req.method === "POST" && req.url === "/exit") {
        const body = await readJson(req);
        if (body.nonce !== NONCE) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        // THE diagnostic Hosted Link never gave us — log only the named fields.
        log(
          `🔎 PLAID ONEXIT — error_code=${body.error_code || "(none)"} type=${body.error_type || "(none)"} ` +
            `status=${body.status || "(none)"} display_message=${JSON.stringify(body.display_message || null)} ` +
            `error_message=${JSON.stringify(body.error_message || null)} institution=${body.institution_id || "(none)"} ` +
            `request_id=${body.request_id || "(none)"}`
        );
        log("   (server still up — Nate can retry from the same page, or re-run to mint a fresh token.)");
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end();
      log(`request error: ${e?.message || e}`);
    }
  });

  server.on("error", (e) => {
    if (e && e.code === "EADDRINUSE") fail(`port ${PORT} is already in use — pass --port N to pick another.`);
    fail(`server error: ${e?.message || e}`);
  });

  server.listen(PORT, "127.0.0.1", () => {
    log(`🔗 CONNECT PAGE READY — open this on this Mac to connect Associated Bank:`);
    log(`     http://127.0.0.1:${PORT}/`);
    log(`   Read-only on the bank. Watching up to ${Math.round(WATCH_SECONDS / 60)} min for you to finish.`);
  });

  setTimeout(() => {
    log("⏳ TIMEOUT — window elapsed without a completed connect. Re-run to try again.");
    server.close();
    releaseLock();
    process.exit(2);
  }, WATCH_SECONDS * 1000).unref();
}

main().catch((e) => fail(e?.message || String(e)));
