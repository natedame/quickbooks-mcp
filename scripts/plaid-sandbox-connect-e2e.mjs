#!/usr/bin/env node
// SANDBOX end-to-end proof of the production connect-capture MECHANISM.
//
// Proves the exact getLinkSessionResult -> selectCapturedSession -> exchange path
// that production will use, against a REAL completed Plaid Hosted Link session
// (driven externally by puppeteer with sandbox test creds) — not the token-mint
// shortcut the smoke test uses. Sandbox only; touches no real bank, no money, $0.
//
//   node scripts/plaid-sandbox-connect-e2e.mjs gen
//        -> prints LINK_TOKEN=... and URL=... (drive URL in a browser to connect)
//   node scripts/plaid-sandbox-connect-e2e.mjs poll <link_token>
//        -> polls the real session, asserts the public_token is captured + exchanged

process.env.PLAID_ENV = "sandbox";
const { PlaidClient } = await import("../dist/plaid/client.js");

const plaid = new PlaidClient(undefined, "sandbox");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const perr = (e) => (e?.response?.data ? JSON.stringify(e.response.data) : e?.message || String(e));

const mode = process.argv[2];

if (mode === "gen") {
  const link = await plaid.createHostedLink("sandbox-e2e-user", { urlLifetimeSeconds: 3600 });
  console.log(`LINK_TOKEN=${link.link_token}`);
  console.log(`URL=${link.hosted_link_url}`);
  process.exit(0);
} else if (mode === "poll") {
  const linkToken = process.argv[3];
  if (!linkToken) {
    console.error("usage: poll <link_token>");
    process.exit(2);
  }
  const deadline = Date.now() + 240000; // 4 min
  while (Date.now() < deadline) {
    let r;
    try {
      r = await plaid.getLinkSessionResult(linkToken);
    } catch (e) {
      console.log(`  …polling error (retrying): ${perr(e)}`);
      await sleep(4000);
      continue;
    }
    if (r.publicToken) {
      console.log(`  ✓ captured public_token via getLinkSessionResult (institution=${r.institutionName || r.institutionId})`);
      const ex = await plaid.exchangePublicToken(r.publicToken);
      if (!ex.access_token) throw new Error("exchange returned no access_token");
      console.log(`  ✓ exchanged for access_token, item_id=${ex.item_id}`);
      const page = await plaid.syncTransactions(ex.access_token);
      console.log(`  ✓ live read-back: ${(page.accounts || []).length} account(s), ${page.added.length} txns on first page`);
      for (const a of (page.accounts || []).slice(0, 4)) {
        console.log(`      • ${a.name} …${a.mask || "?"} (${a.subtype || a.type}) bal=${a.current}`);
      }
      console.log("\n✅ SANDBOX E2E CAPTURE PASSED — real getLinkSessionResult capture path works end to end.");
      process.exit(0);
    }
    if (r.exited) {
      console.error("\n❌ session finished as EXITED (connect abandoned) — retry the browser flow.");
      process.exit(1);
    }
    console.log("  …waiting for the hosted-link session to finish…");
    await sleep(4000);
  }
  console.error("\n❌ TIMEOUT — session did not complete within 4 min.");
  process.exit(1);
} else {
  console.error("usage: gen | poll <link_token>");
  process.exit(2);
}
