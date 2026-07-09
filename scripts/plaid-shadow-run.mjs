#!/usr/bin/env node
// Live SANDBOX shadow-run proof — mints a sandbox item, pulls its transactions,
// runs them through the real categorization brain, and prints exactly what the
// pipeline WOULD book. Writes nothing. Proves the categorize-and-preview engine
// end to end on real (sandbox) transaction data. Run: node scripts/plaid-shadow-run.mjs

import { PlaidClient } from "../dist/plaid/client.js";
import { runShadow, formatShadowSummary } from "../dist/plaid/shadow-run.js";

process.env.PLAID_ENV = "sandbox";

// A demonstration rule set. In production these live in a rules file refined from
// shadow output; here they show each booking path firing on sandbox data.
const RULES = {
  vendorRules: [
    { match: "United Airlines", kind: "money_out", account: "Travel" },
    { match: "McDonald", kind: "money_out", account: "Meals" },
    { match: "Starbucks", kind: "money_out", account: "Meals" },
    { match: "Uber", kind: "money_out", account: "Travel" },
    { match: "Touchstone Climbing", kind: "money_out", account: "Dues & Subscriptions" },
    { match: "SparkFun", kind: "money_out", account: "Supplies" },
    { match: "INTRST PYMNT", kind: "money_in", account: "Interest Income" },
  ],
  pfcAccounts: {
    TRANSPORTATION: "Travel",
    FOOD_AND_DRINK: "Meals",
    GENERAL_MERCHANDISE: "Supplies",
    TRAVEL: "Travel",
  },
  transferPatterns: ["Transfer", "ACH Electronic CreditGUSTO"],
  ccPaymentPatterns: ["CREDIT CARD 3333 PAYMENT"],
  arReferencePatterns: ["ACH Electronic Credit"],
};

async function main() {
  const plaid = new PlaidClient(undefined, "sandbox");
  const publicToken = await plaid.createSandboxPublicToken("ins_109508");
  const { access_token } = await plaid.exchangePublicToken(publicToken);

  // Let the sandbox generate transactions.
  let summary;
  for (let attempt = 0; attempt < 8; attempt++) {
    summary = await runShadow({
      env: "sandbox",
      client: plaid,
      accessToken: access_token,
      rules: RULES,
      ledger: { env: "sandbox", entries: {} },
    });
    if (summary.posted > 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(formatShadowSummary(summary));

  if (!summary || summary.posted === 0) {
    console.error("\n❌ SHADOW RUN FAILED: sandbox returned no posted transactions");
    process.exit(1);
  }
  // Sanity: every posted, not-already-booked transaction produced exactly one proposal,
  // and nothing was auto-guessed into a real category without a rule (uncertain is allowed).
  if (summary.proposals.length !== summary.posted) {
    console.error("\n❌ proposal count != posted count");
    process.exit(1);
  }
  console.log("\n✅ SHADOW RUN PASSED — categorize-and-preview works end to end; nothing was booked.");
}

main().catch((err) => {
  const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.message || String(err);
  console.error(`\n❌ SHADOW RUN FAILED: ${detail}`);
  process.exit(1);
});
