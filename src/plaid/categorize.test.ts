// Unit tests for the categorization brain. This is the accounting heart, so every
// booking path, the Plaid sign convention, and rule precedence are pinned down.

import { describe, it, expect } from "vitest";
import { categorize, categorizeBatch, type CategorizationRules } from "./categorize.js";
import type { PlaidTransaction } from "./client.js";

function txn(overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: overrides.transaction_id ?? "t1",
    account_id: overrides.account_id ?? "acc1",
    amount: overrides.amount ?? 10, // positive = money OUT
    date: overrides.date ?? "2026-07-08",
    name: overrides.name ?? "SOME MERCHANT",
    merchant_name: overrides.merchant_name,
    pending: overrides.pending ?? false,
    personal_finance_category: overrides.personal_finance_category,
    payment_channel: overrides.payment_channel,
  };
}

const RULES: CategorizationRules = {
  vendorRules: [
    { match: "PG&E", kind: "money_out", account: "Utilities" },
    { match: "Simplisafe", kind: "money_out", account: "Alarm" },
    { match: "Stripe Payout", kind: "money_in", account: "Sales" },
  ],
  pfcAccounts: { GENERAL_SERVICES: "Professional Services", FOOD_AND_DRINK: "Meals" },
  transferPatterns: ["Transfer to Savings", "Online Transfer"],
  ccPaymentPatterns: ["CHASE CREDIT CRD EPAY", "Card Payment"],
  arReferencePatterns: ["REPAY", "Arthritis Foundation"],
};

describe("categorize — sign convention", () => {
  it("positive amount = money OUT", () => {
    expect(categorize(txn({ amount: 50, name: "Unknown Co" }), RULES).direction).toBe("out");
  });
  it("negative amount = money IN", () => {
    expect(categorize(txn({ amount: -50, name: "Unknown Co" }), RULES).direction).toBe("in");
  });
  it("amount_cents is the positive magnitude regardless of sign", () => {
    expect(categorize(txn({ amount: -12.34, name: "Unknown Co" }), RULES).amount_cents).toBe(1234);
    expect(categorize(txn({ amount: 12.34, name: "Unknown Co" }), RULES).amount_cents).toBe(1234);
  });
  it("zero amount is uncertain", () => {
    expect(categorize(txn({ amount: 0 }), RULES).kind).toBe("uncertain");
  });
});

describe("categorize — vendor rules", () => {
  it("expense vendor debit -> money_out with its account", () => {
    const p = categorize(txn({ amount: 120, merchant_name: "PG&E" }), RULES);
    expect(p.kind).toBe("money_out");
    expect(p.qbo_account).toBe("Utilities");
    expect(p.confidence).toBe("high");
  });
  it("income vendor credit -> money_in with its account", () => {
    const p = categorize(txn({ amount: -500, name: "Stripe Payout 123" }), RULES);
    expect(p.kind).toBe("money_in");
    expect(p.qbo_account).toBe("Sales");
  });
  it("credit from an EXPENSE vendor -> refund (contra), not income", () => {
    const p = categorize(txn({ amount: -30, merchant_name: "Simplisafe" }), RULES);
    expect(p.kind).toBe("refund");
    expect(p.qbo_account).toBe("Alarm");
  });
  it("debit against an INCOME vendor -> uncertain (unexpected)", () => {
    const p = categorize(txn({ amount: 40, name: "Stripe Payout reversal" }), RULES);
    expect(p.kind).toBe("uncertain");
  });
});

describe("categorize — transaction types & precedence", () => {
  it("transfer pattern beats everything", () => {
    const p = categorize(txn({ amount: 1000, name: "Online Transfer to Savings" }), RULES);
    expect(p.kind).toBe("transfer");
  });
  it("credit-card payment pattern -> cc_payment (not expense)", () => {
    const p = categorize(txn({ amount: 800, name: "CHASE CREDIT CRD EPAY" }), RULES);
    expect(p.kind).toBe("cc_payment");
  });
  it("inflow matching an AR reference -> ar_settlement (apply, don't deposit)", () => {
    const p = categorize(txn({ amount: -2500, name: "REPAY ACH DEPOSIT" }), RULES);
    expect(p.kind).toBe("ar_settlement");
  });
  it("AR reference on an OUTFLOW is NOT ar_settlement", () => {
    const p = categorize(txn({ amount: 2500, name: "REPAY fee" }), RULES);
    expect(p.kind).not.toBe("ar_settlement");
  });
});

describe("categorize — Plaid PFC fallback and uncertain", () => {
  it("uses PFC mapping at medium confidence when no vendor rule matches", () => {
    const p = categorize(
      txn({ amount: 75, name: "New Consultant LLC", personal_finance_category: { primary: "GENERAL_SERVICES", detailed: "x" } }),
      RULES
    );
    expect(p.kind).toBe("money_out");
    expect(p.qbo_account).toBe("Professional Services");
    expect(p.confidence).toBe("medium");
  });
  it("uncertain (low) when nothing matches and no PFC mapping", () => {
    const p = categorize(txn({ amount: 99, name: "Totally Unknown Vendor XYZ" }), RULES);
    expect(p.kind).toBe("uncertain");
    expect(p.confidence).toBe("low");
  });
  it("uncertain when PFC exists but is unmapped", () => {
    const p = categorize(
      txn({ amount: 99, name: "Unknown", personal_finance_category: { primary: "RENT_AND_UTILITIES", detailed: "x" } }),
      RULES
    );
    expect(p.kind).toBe("uncertain");
    expect(p.reason).toMatch(/unmapped/);
  });
});

describe("categorizeBatch", () => {
  it("filters out pending transactions (only pending=false is booked)", () => {
    const batch = [
      txn({ transaction_id: "posted", amount: 10, pending: false }),
      txn({ transaction_id: "pending", amount: 20, pending: true }),
    ];
    const out = categorizeBatch(batch, RULES);
    expect(out).toHaveLength(1);
    expect(out[0].transaction_id).toBe("posted");
  });
});
