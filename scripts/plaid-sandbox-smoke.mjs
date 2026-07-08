#!/usr/bin/env node
// Live Plaid SANDBOX smoke test — proves the full read-only flow end to end
// against Plaid's free sandbox, using the sandbox secret in ~/.secrets/plaid.env.
// No real bank, no money, no cost. Run: node scripts/plaid-sandbox-smoke.mjs
//
// Exercises, in order: config load -> Hosted Link token -> sandbox public token
// -> exchange -> item/get -> transactions/sync (full cursor loop) -> balances
// -> institution lookup. Exits non-zero on any failure so CI/the host can gate.

import { getPlaidConfig } from "../dist/plaid/config.js";
import { PlaidClient } from "../dist/plaid/client.js";

// Force sandbox regardless of ambient env — this script must never touch production.
process.env.PLAID_ENV = "sandbox";

function ok(msg) { console.log(`  ✓ ${msg}`); }
function section(msg) { console.log(`\n── ${msg}`); }

async function main() {
  section("1. Config");
  const cfg = getPlaidConfig();
  if (cfg.env !== "sandbox") throw new Error(`expected sandbox, got ${cfg.env}`);
  if (!cfg.clientId || !cfg.secret) throw new Error("missing client_id or sandbox secret");
  ok(`env=${cfg.env}, client_id=${cfg.clientId.slice(0, 6)}…, secret present`);

  const plaid = new PlaidClient(undefined, "sandbox");

  section("2. Hosted Link token (the real connect flow)");
  const link = await plaid.createHostedLink("smoke-test-user");
  if (!link.hosted_link_url.startsWith("http")) throw new Error("no hosted_link_url");
  ok(`hosted_link_url returned (expires ${link.expiration})`);

  section("3. Sandbox public token -> exchange for durable access_token");
  const publicToken = await plaid.createSandboxPublicToken("ins_109508");
  ok(`sandbox public_token minted`);
  const { access_token, item_id } = await plaid.exchangePublicToken(publicToken);
  if (!access_token) throw new Error("no access_token from exchange");
  ok(`access_token acquired, item_id=${item_id}`);

  section("4. item/get -> institution_id");
  const institutionId = await plaid.getItemInstitutionId(access_token);
  ok(`institution_id=${institutionId}`);

  section("5. transactions/sync (full cursor loop)");
  let cursor;
  let pages = 0;
  let added = 0;
  let posted = 0;
  let pending = 0;
  let lastAccounts;
  // Sandbox data can take a moment to be ready; sync returns has_more=false when caught up.
  // Retry the first page a few times if the item is still initializing (added empty + no cursor movement).
  for (let attempt = 0; attempt < 8; attempt++) {
    let has_more = true;
    cursor = undefined;
    pages = 0; added = 0; posted = 0; pending = 0;
    while (has_more) {
      const page = await plaid.syncTransactions(access_token, cursor);
      pages++;
      added += page.added.length;
      for (const t of page.added) (t.pending ? pending++ : posted++);
      if (page.accounts) lastAccounts = page.accounts;
      cursor = page.next_cursor;
      has_more = page.has_more;
    }
    if (added > 0) break;
    await new Promise((r) => setTimeout(r, 2000)); // sandbox still generating txns
  }
  ok(`synced ${pages} page(s): ${added} transactions (${posted} posted, ${pending} pending)`);
  if (added === 0) throw new Error("sandbox returned zero transactions after retries");

  section("6. Balances");
  // Prefer balances carried free on the sync response; fall back to the paid endpoint.
  const balances = lastAccounts && lastAccounts.length ? lastAccounts : await plaid.getBalances(access_token);
  ok(`${balances.length} account(s); source=${lastAccounts ? "sync (free)" : "balance/get (paid)"}`);
  for (const b of balances.slice(0, 3)) {
    ok(`  ${b.name} (${b.subtype}): current=${b.current} ${b.iso_currency_code || ""}`);
  }
  if (!balances.length) throw new Error("no account balances returned");

  section("7. Institution lookup (auth type + products)");
  const inst = await plaid.getInstitution("ins_109508");
  ok(`${inst.name}: oauth=${inst.oauth}, transactions=${inst.supports_transactions}`);

  console.log("\n✅ SANDBOX SMOKE PASSED — full read-only Plaid flow works end to end.");
}

main().catch((err) => {
  const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.message || String(err);
  console.error(`\n❌ SANDBOX SMOKE FAILED: ${detail}`);
  process.exit(1);
});
