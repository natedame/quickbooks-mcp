// The categorization brain: decide, for one posted bank transaction, HOW it
// should be booked into QuickBooks — WITHOUT ever guessing.
//
// Design principles (from the plan):
//  - Deterministic rules first (known vendors), then Plaid's personal_finance_category
//    as a fallback signal. Anything not confidently mapped is marked `uncertain` and
//    routed to a human (a host ticket) — it is NEVER auto-booked on a guess.
//  - Transaction-type awareness: transfers, credit-card payments, refunds, and AR
//    settlements are booked distinctly, not lumped as generic income/expense.
//  - AR skip-rule: an inflow that settles a customer invoice is flagged `ar_settlement`
//    (to be applied via create_payment), so it is never ALSO booked as a generic deposit.
//  - Pure functions over a data-driven rule set, so rules are refined from shadow output
//    without code changes.
//
// Plaid sign convention (critical): amount POSITIVE = money OUT of the account (debit);
// amount NEGATIVE = money IN (credit).

import { toCents } from "../utils/money.js";
import type { PlaidTransaction } from "./client.js";

export type BookingKind =
  | "money_out" // -> Purchase (expense account on the line)
  | "money_in" // -> Deposit (income/category account on the line)
  | "transfer" // -> Transfer/clearing (not P&L)
  | "cc_payment" // -> credit-card liability payment (not an expense)
  | "refund" // -> contra against the original expense account (not income)
  | "ar_settlement" // -> customer invoice Payment (via create_payment); skip generic booking
  | "uncertain"; // -> route to a host ticket; never auto-booked

export interface BookingProposal {
  transaction_id: string;
  date: string;
  name: string;
  amount_cents: number; // always positive (magnitude)
  direction: "out" | "in";
  kind: BookingKind;
  qbo_account?: string; // proposed account name, when a rule supplies one
  confidence: "high" | "medium" | "low";
  reason: string; // human-readable justification (shown in shadow preview + host ticket)
}

export interface VendorRule {
  /** case-insensitive substring matched against merchant_name then name */
  match: string;
  /** how a NORMAL-direction charge from this vendor books (money_out for expenses, money_in for income) */
  kind: "money_out" | "money_in";
  account?: string;
}

export interface CategorizationRules {
  vendorRules: VendorRule[];
  /** Plaid personal_finance_category primary -> QBO account, used as a fallback mapping. */
  pfcAccounts?: Record<string, string>;
  /** name substrings indicating a transfer between the company's own accounts. */
  transferPatterns?: string[];
  /** name substrings indicating a credit-card bill payment. */
  ccPaymentPatterns?: string[];
  /** inflow reference substrings that settle a customer invoice (apply, don't deposit). */
  arReferencePatterns?: string[];
}

export const EMPTY_RULES: CategorizationRules = { vendorRules: [] };

function nameMatches(txn: PlaidTransaction, needle: string): boolean {
  const n = needle.toLowerCase();
  return (
    (txn.merchant_name || "").toLowerCase().includes(n) ||
    (txn.name || "").toLowerCase().includes(n)
  );
}

/**
 * Categorize a single POSTED transaction into a booking proposal.
 * Callers must filter out pending transactions before calling this.
 */
export function categorize(txn: PlaidTransaction, rules: CategorizationRules): BookingProposal {
  const name = txn.merchant_name || txn.name || "(unnamed)";
  const amountCents = Math.abs(toCents(txn.amount));
  const base = {
    transaction_id: txn.transaction_id,
    date: txn.date,
    name,
    amount_cents: amountCents,
  };

  // Zero-amount or nonsense: never guess.
  if (amountCents === 0) {
    return { ...base, direction: "out", kind: "uncertain", confidence: "low", reason: "zero-amount transaction" };
  }

  const direction: "out" | "in" = txn.amount > 0 ? "out" : "in";

  // 1. Transfers between own accounts — most specific, must not book as expense/income.
  for (const p of rules.transferPatterns || []) {
    if (nameMatches(txn, p)) {
      return { ...base, direction, kind: "transfer", confidence: "high", reason: `transfer pattern "${p}"` };
    }
  }

  // 2. Credit-card bill payments — liability payment, not an expense.
  for (const p of rules.ccPaymentPatterns || []) {
    if (nameMatches(txn, p)) {
      return { ...base, direction, kind: "cc_payment", confidence: "high", reason: `credit-card payment pattern "${p}"` };
    }
  }

  // 3. AR settlements (inflows only) — apply to an invoice, do NOT also deposit.
  if (direction === "in") {
    for (const p of rules.arReferencePatterns || []) {
      if (nameMatches(txn, p)) {
        return {
          ...base,
          direction,
          kind: "ar_settlement",
          confidence: "high",
          reason: `AR reference "${p}" — apply to invoice via create_payment, not a generic deposit`,
        };
      }
    }
  }

  // 4. Known-vendor rules.
  for (const rule of rules.vendorRules) {
    if (!nameMatches(txn, rule.match)) continue;

    // A credit (money in) from a vendor whose normal charge is an expense = a refund:
    // net it against the original expense account, not booked as income.
    if (direction === "in" && rule.kind === "money_out") {
      return {
        ...base,
        direction,
        kind: "refund",
        qbo_account: rule.account,
        confidence: "high",
        reason: `refund from expense vendor "${rule.match}" — contra to ${rule.account || "the original expense account"}`,
      };
    }
    // A debit against an income vendor is unusual — don't guess.
    if (direction === "out" && rule.kind === "money_in") {
      return {
        ...base,
        direction,
        kind: "uncertain",
        confidence: "low",
        reason: `debit against income vendor "${rule.match}" — unexpected, needs review`,
      };
    }
    return {
      ...base,
      direction,
      kind: rule.kind,
      qbo_account: rule.account,
      confidence: "high",
      reason: `vendor rule "${rule.match}"`,
    };
  }

  // 5. Plaid personal_finance_category fallback (a signal, medium confidence).
  const pfc = txn.personal_finance_category?.primary;
  if (pfc && rules.pfcAccounts && rules.pfcAccounts[pfc]) {
    return {
      ...base,
      direction,
      kind: direction === "out" ? "money_out" : "money_in",
      qbo_account: rules.pfcAccounts[pfc],
      confidence: "medium",
      reason: `Plaid category ${pfc} -> ${rules.pfcAccounts[pfc]}`,
    };
  }

  // 6. Nothing matched confidently — route to a human, never auto-book.
  return {
    ...base,
    direction,
    kind: "uncertain",
    confidence: "low",
    reason: pfc ? `no rule; Plaid category ${pfc} unmapped` : "no rule and no Plaid category",
  };
}

/** Convenience: categorize a batch of posted transactions. */
export function categorizeBatch(txns: PlaidTransaction[], rules: CategorizationRules): BookingProposal[] {
  return txns.filter((t) => !t.pending).map((t) => categorize(t, rules));
}
