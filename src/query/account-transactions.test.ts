// Unit tests for extractAccountLines (GEN-7941). These lock the fix for a silent
// omission: query_account_transactions queried only 7 of the 12 QuickBooks entity
// types that post to the general ledger, so bill payments, transfers, vendor
// credits, credit memos and refund receipts were invisible, and the A/R account
// returned essentially nothing.
//
// Every fixture below is shaped from a REAL QuickBooks API response captured while
// diagnosing the bug (notably: bill payments carry NO APAccountRef, and vendor
// credit lines can hold negative amounts). QuickBooks is never contacted.

import { describe, it, expect } from "vitest";
import { extractAccountLines, resolveDefaultAccountId, POSTING_ENTITY_TYPES } from "./account-transactions.js";
import { AccountCache, CachedAccount, TransactionLine } from "../types/index.js";
import { toCents, toDollars } from "../utils/index.js";

const AP = "13";        // 20000 Accounts Payable
const AR = "11";        // 11000 Accounts Receivable
const BANK = "1150040000"; // 10600 Associated Bank Checking-3491
const CC = "422";       // 8397 Chase Credit:Nate CC
const INCOME = "6";     // 42700 Consulting Income
const EXPENSE = "59";   // 74250 Overhead Software Expense
const UNDEPOSITED = "12";

function makeCache(extra: CachedAccount[] = []): AccountCache {
  const items: CachedAccount[] = [
    { Id: AP, Name: "Accounts Payable", AcctNum: "20000", AccountType: "Accounts Payable", AccountSubType: "AccountsPayable", Active: true },
    { Id: AR, Name: "Accounts Receivable", AcctNum: "11000", AccountType: "Accounts Receivable", AccountSubType: "AccountsReceivable", Active: true },
    { Id: BANK, Name: "Associated Bank Checking-3491", AcctNum: "10600", AccountType: "Bank", AccountSubType: "Checking", Active: true },
    { Id: CC, Name: "Nate CC", AcctNum: "8397", AccountType: "Credit Card", AccountSubType: "CreditCard", Active: true },
    { Id: INCOME, Name: "Consulting Income", AcctNum: "42700", AccountType: "Income", AccountSubType: "ServiceFeeIncome", Active: true },
    { Id: EXPENSE, Name: "Overhead Software Expense", AcctNum: "74250", AccountType: "Expense", AccountSubType: "OtherMiscellaneousServiceCost", Active: true },
    { Id: UNDEPOSITED, Name: "Undeposited Funds", AcctNum: "12000", AccountType: "Other Current Asset", AccountSubType: "UndepositedFunds", Active: true },
    ...extra,
  ];
  return {
    items,
    byId: new Map(items.map(a => [a.Id, a])),
    byName: new Map(items.map(a => [a.Name.toLowerCase(), a])),
    byAcctNum: new Map(items.filter(a => a.AcctNum).map(a => [a.AcctNum!.toLowerCase(), a])),
    fetchedAt: Date.now(),
  };
}

// Summary maths mirrors handleQueryAccountTransactions: only matching lines count.
function totals(lines: TransactionLine[]) {
  const matching = lines.filter(l => l.isMatchingLine);
  const sum = (ls: TransactionLine[], pick: (l: TransactionLine) => number) =>
    toDollars(ls.reduce((cents, l) => cents + toCents(pick(l)), 0));
  return {
    debits: sum(matching.filter(l => l.amount > 0), l => l.amount),
    credits: sum(matching.filter(l => l.amount < 0), l => Math.abs(l.amount)),
    count: matching.length,
  };
}

// --- Real captured shapes -------------------------------------------------

// Note the absent APAccountRef, and Line[] carrying only { Amount, LinkedTxn }.
function billPaymentByCard(id: string, amount: number, date = "2026-01-28") {
  return {
    Id: id, TxnDate: date, TotalAmt: amount, PayType: "CreditCard",
    CreditCardPayment: { CCAccountRef: { value: CC, name: "Chase Credit:Nate CC" } },
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: "56256", TxnType: "Bill" }] }],
  };
}

function billPaymentByCheck(id: string, amount: number, date = "2026-03-01") {
  return {
    Id: id, TxnDate: date, TotalAmt: amount, PayType: "Check", DocNumber: "Bill.com",
    CheckPayment: { BankAccountRef: { value: BANK, name: "Associated Bank Checking-3491" }, PrintStatus: "NotSet" },
    Line: [
      { Amount: 125, LinkedTxn: [{ TxnId: "55734", TxnType: "Bill" }] },
      { Amount: 200, LinkedTxn: [{ TxnId: "56039", TxnType: "Bill" }] },
      { Amount: 150, LinkedTxn: [{ TxnId: "55947", TxnType: "Bill" }] },
      { Amount: 100, LinkedTxn: [{ TxnId: "55948", TxnType: "Bill" }] },
    ],
  };
}

function bill(id: string, amount: number, date: string) {
  return {
    Id: id, TxnDate: date, TotalAmt: amount,
    APAccountRef: { value: AP, name: "Accounts Payable" },
    Line: [{
      Id: "1", Amount: amount, DetailType: "AccountBasedExpenseLineDetail",
      AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE, name: "74250 Overhead Software Expense" } },
    }],
  };
}

function transfer(id: string, amount: number, from: string, to: string, date = "2026-04-15") {
  return { Id: id, TxnDate: date, Amount: amount, FromAccountRef: { value: from }, ToAccountRef: { value: to } };
}

function invoice(id: string, amount: number, date = "2026-06-26") {
  return {
    Id: id, TxnDate: date, TotalAmt: amount,
    Line: [
      { Id: "1", Amount: amount, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemAccountRef: { value: INCOME, name: "42700 Consulting Income" }, ItemRef: { name: "SEO" } } },
      { Amount: amount, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
    ],
  };
}

function payment(id: string, amount: number, depositTo?: string, date = "2026-05-28") {
  return {
    Id: id, TxnDate: date, TotalAmt: amount, UnappliedAmt: 0,
    ...(depositTo ? { DepositToAccountRef: { value: depositTo } } : {}),
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: "9", TxnType: "Invoice" }] }],
  };
}

// --- The reported bug -----------------------------------------------------

describe("BillPayment (the reported omission)", () => {
  it("reproduces the live A/P period exactly: $4,478.75 debits / $2,156.00 credits", () => {
    const cache = makeCache();
    const payments = [
      billPaymentByCard("56260", 922.5),
      billPaymentByCard("56258", 630),
      billPaymentByCard("56259", 2351.25),
      billPaymentByCheck("56040", 575),
    ];
    const bills = [
      bill("56257", 630, "2026-01-20"), bill("b2", 200, "2026-01-31"),
      bill("b3", 400, "2026-04-01"), bill("b4", 350, "2026-04-01"),
      bill("b5", 550, "2026-04-30"), bill("b6", 26, "2026-05-01"),
    ];

    const lines = [
      ...extractAccountLines(payments, "BillPayment", AP, cache),
      ...extractAccountLines(bills, "Bill", AP, cache),
    ];

    // These are the GeneralLedger report's own figures for account 20000 over
    // 2026-01-01..2026-07-27. Before the fix the debit side read $0.00.
    expect(totals(lines)).toEqual({ debits: 4478.75, credits: 2156, count: 10 });
  });

  it("debits A/P even though QuickBooks omits APAccountRef", () => {
    const lines = extractAccountLines([billPaymentByCard("1", 922.5)], "BillPayment", AP, makeCache());
    const ap = lines.filter(l => l.isMatchingLine);
    expect(ap).toHaveLength(1);
    expect(ap[0].amount).toBe(922.5); // positive = debit, reduces the payable
    expect(ap[0].accountId).toBe(AP);
  });

  it("credits the credit-card account it was paid from", () => {
    const lines = extractAccountLines([billPaymentByCard("1", 922.5)], "BillPayment", CC, makeCache());
    const matched = lines.filter(l => l.isMatchingLine);
    expect(matched).toHaveLength(1);
    expect(matched[0].amount).toBe(-922.5);
  });

  it("credits the bank account for a check payment", () => {
    const lines = extractAccountLines([billPaymentByCheck("1", 575)], "BillPayment", BANK, makeCache());
    const matched = lines.filter(l => l.isMatchingLine);
    expect(matched).toHaveLength(1);
    expect(matched[0].amount).toBe(-575);
  });

  it("never posts Line[] — those only point at the bills being paid", () => {
    // The check payment has four lines totalling 575 against paid bills. Posting
    // them would double-count the bills' own expense lines.
    const lines = extractAccountLines([billPaymentByCheck("1", 575)], "BillPayment", EXPENSE, makeCache());
    expect(lines).toHaveLength(0);

    const all = extractAccountLines([billPaymentByCheck("1", 575)], "BillPayment", AP, makeCache());
    expect(all).toHaveLength(2); // A/P side + funding side, nothing more
    expect(all.map(l => l.lineId).sort()).toEqual(["funding", "header"]);
  });

  it("respects an explicit APAccountRef over the default", () => {
    const other = "999";
    const cache = makeCache([{ Id: other, Name: "AP - Secondary", AccountType: "Accounts Payable", AccountSubType: "AccountsPayable", Active: true }]);
    const bp = { ...billPaymentByCard("1", 100), APAccountRef: { value: other } };
    const lines = extractAccountLines([bp], "BillPayment", other, cache);
    expect(lines.filter(l => l.isMatchingLine)).toHaveLength(1);
  });
});

// --- The rest of the omission class --------------------------------------

describe("Transfer", () => {
  it("debits the destination and credits the source", () => {
    const cache = makeCache();
    const lines = extractAccountLines([transfer("1", 910, BANK, "40")], "Transfer", BANK, cache);
    const matched = lines.filter(l => l.isMatchingLine);
    expect(matched).toHaveLength(1);
    expect(matched[0].amount).toBe(-910); // money left this account
    expect(lines.find(l => l.accountId === "40")?.amount).toBe(910);
  });

  it("nets the live bank period to the ledger's +$1,990.00", () => {
    const cache = makeCache();
    const rows = [
      transfer("56184", 910, BANK, "40"),
      transfer("56098", 200, BANK, "40"),
      transfer("56096", 3100, "40", BANK),
    ];
    const lines = extractAccountLines(rows, "Transfer", BANK, cache);
    const t = totals(lines);
    expect(t.debits - t.credits).toBe(1990);
  });

  it("is excluded under a department filter, since transfers carry no department", () => {
    const lines = extractAccountLines([transfer("1", 910, BANK, "40")], "Transfer", BANK, makeCache(), "7");
    expect(lines).toHaveLength(0);
  });
});

describe("VendorCredit", () => {
  const vc = {
    Id: "48204", TxnDate: "2022-01-03", TotalAmt: 1214.2,
    APAccountRef: { value: AP },
    Line: [
      { Id: "1", Amount: 10724.23, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE } } },
      { Id: "2", Amount: -9510.03, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: EXPENSE } } },
    ],
  };

  it("debits A/P, reducing the payable", () => {
    const lines = extractAccountLines([vc], "VendorCredit", AP, makeCache());
    const matched = lines.filter(l => l.isMatchingLine);
    expect(matched).toHaveLength(1);
    expect(matched[0].amount).toBe(1214.2);
  });

  it("flips negative line amounts uniformly rather than negating a magnitude", () => {
    // Captured from a real vendor credit: one line is +10,724.23, the other
    // -9,510.03. A uniform flip is what makes them net back to the header.
    const lines = extractAccountLines([vc], "VendorCredit", EXPENSE, makeCache());
    const matched = lines.filter(l => l.isMatchingLine);
    expect(matched.map(l => l.amount)).toEqual([-10724.23, 9510.03]);
    expect(toDollars(matched.reduce((cents, l) => cents + toCents(l.amount), 0))).toBe(-1214.2);
  });
});

describe("CreditMemo", () => {
  const cm = {
    Id: "52751", TxnDate: "2023-09-25", TotalAmt: 158.6,
    Line: [
      { Id: "1", Amount: 158.6, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemAccountRef: { value: INCOME }, ItemRef: { name: "SEO" } } },
      { Amount: 158.6, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
    ],
  };

  it("credits A/R and debits income, and skips the subtotal line", () => {
    const cache = makeCache();
    expect(extractAccountLines([cm], "CreditMemo", AR, cache).filter(l => l.isMatchingLine)[0].amount).toBe(-158.6);

    const income = extractAccountLines([cm], "CreditMemo", INCOME, cache).filter(l => l.isMatchingLine);
    expect(income).toHaveLength(1); // the SubTotalLineDetail row must not post
    expect(income[0].amount).toBe(158.6);
  });
});

describe("RefundReceipt", () => {
  it("credits the refunding account and debits income", () => {
    const rr = {
      Id: "1", TxnDate: "2026-02-01", TotalAmt: 250,
      DepositToAccountRef: { value: BANK },
      Line: [{ Id: "1", Amount: 250, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemAccountRef: { value: INCOME } } }],
    };
    const cache = makeCache();
    expect(extractAccountLines([rr], "RefundReceipt", BANK, cache).filter(l => l.isMatchingLine)[0].amount).toBe(-250);
    expect(extractAccountLines([rr], "RefundReceipt", INCOME, cache).filter(l => l.isMatchingLine)[0].amount).toBe(250);
  });
});

// --- A/R, which returned nothing at all before the fix --------------------

describe("Accounts Receivable", () => {
  it("shows invoices as debits and payments as credits", () => {
    const cache = makeCache();
    const lines = [
      ...extractAccountLines([invoice("i1", 3200)], "Invoice", AR, cache),
      ...extractAccountLines([payment("p1", 1200, BANK)], "Payment", AR, cache),
    ];
    expect(totals(lines)).toEqual({ debits: 3200, credits: 1200, count: 2 });
  });

  it("still debits the bank account for the payment's deposit side", () => {
    const lines = extractAccountLines([payment("p1", 1200, BANK)], "Payment", BANK, makeCache());
    expect(lines.filter(l => l.isMatchingLine)[0].amount).toBe(1200);
  });

  it("falls back to Undeposited Funds when DepositToAccountRef is absent", () => {
    const lines = extractAccountLines([payment("p1", 1200)], "Payment", UNDEPOSITED, makeCache());
    expect(lines.filter(l => l.isMatchingLine)[0].amount).toBe(1200);
  });
});

// --- No regression on what already worked ---------------------------------

describe("existing behaviour is preserved", () => {
  it("an income-account query returns the same totals as before the A/R header existed", () => {
    const lines = extractAccountLines([invoice("i1", 3200)], "Invoice", INCOME, makeCache());
    expect(totals(lines)).toEqual({ debits: 0, credits: 3200, count: 1 });
  });

  it("an expense-account query is unaffected by bill payments", () => {
    const cache = makeCache();
    const lines = [
      ...extractAccountLines([bill("b1", 630, "2026-01-20")], "Bill", EXPENSE, cache),
      ...extractAccountLines([billPaymentByCard("bp1", 630)], "BillPayment", EXPENSE, cache),
    ];
    expect(totals(lines)).toEqual({ debits: 630, credits: 0, count: 1 });
  });

  it("counts a bill exactly once on A/P even when its payment is also in range", () => {
    const cache = makeCache();
    const lines = [
      ...extractAccountLines([bill("b1", 630, "2026-01-20")], "Bill", AP, cache),
      ...extractAccountLines([billPaymentByCard("bp1", 630)], "BillPayment", AP, cache),
    ];
    expect(totals(lines)).toEqual({ debits: 630, credits: 630, count: 2 });
  });
});

// --- Fail loud rather than guess ------------------------------------------

describe("default account resolution", () => {
  it("resolves the sole active account of a subtype", () => {
    expect(resolveDefaultAccountId(makeCache(), "AccountsPayable", "Accounts Payable")).toBe(AP);
  });

  it("refuses to guess when several candidates exist, and says so", () => {
    const cache = makeCache([{ Id: "999", Name: "AP - Secondary", AccountType: "Accounts Payable", AccountSubType: "AccountsPayable", Active: true }]);
    expect(resolveDefaultAccountId(cache, "AccountsPayable", "Accounts Payable")).toBeUndefined();

    const warnings: string[] = [];
    const lines = extractAccountLines([billPaymentByCard("1", 922.5)], "BillPayment", AP, cache, undefined, warnings);
    expect(lines.filter(l => l.accountId === AP)).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AccountsPayable");
  });

  it("ignores inactive accounts when picking the default", () => {
    const cache = makeCache([{ Id: "999", Name: "AP - Closed", AccountType: "Accounts Payable", AccountSubType: "AccountsPayable", Active: false }]);
    expect(resolveDefaultAccountId(cache, "AccountsPayable", "Accounts Payable")).toBe(AP);
  });

  it("warns only once per account kind, however many transactions are affected", () => {
    const cache = makeCache([{ Id: "999", Name: "AP - Secondary", AccountType: "Accounts Payable", AccountSubType: "AccountsPayable", Active: true }]);
    const warnings: string[] = [];
    extractAccountLines(
      [billPaymentByCard("1", 100), billPaymentByCard("2", 200), billPaymentByCard("3", 300)],
      "BillPayment", AP, cache, undefined, warnings
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("POSTING_ENTITY_TYPES", () => {
  // One minimal-but-real entity per registered type, with the account it should
  // post to. A registry entry whose extractor case is missing silently yields no
  // lines, so this is the guard that catches it.
  const probe: Record<string, { entity: Record<string, unknown>; account: string }> = {
    JournalEntry: {
      entity: { Id: "1", TxnDate: "2026-01-01", Line: [{ Id: "1", Amount: 100, JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: AP } } }] },
      account: AP,
    },
    Purchase: { entity: { Id: "1", TxnDate: "2026-01-01", TotalAmt: 100, AccountRef: { value: BANK } }, account: BANK },
    Deposit: { entity: { Id: "1", TxnDate: "2026-01-01", TotalAmt: 100, DepositToAccountRef: { value: BANK } }, account: BANK },
    SalesReceipt: { entity: { Id: "1", TxnDate: "2026-01-01", TotalAmt: 100, DepositToAccountRef: { value: BANK } }, account: BANK },
    Bill: { entity: bill("1", 100, "2026-01-01"), account: AP },
    BillPayment: { entity: billPaymentByCard("1", 100), account: AP },
    VendorCredit: { entity: { Id: "1", TxnDate: "2026-01-01", TotalAmt: 100, APAccountRef: { value: AP } }, account: AP },
    Invoice: { entity: invoice("1", 100), account: AR },
    Payment: { entity: payment("1", 100, BANK), account: BANK },
    CreditMemo: { entity: { Id: "1", TxnDate: "2026-01-01", TotalAmt: 100 }, account: AR },
    RefundReceipt: { entity: { Id: "1", TxnDate: "2026-01-01", TotalAmt: 100, DepositToAccountRef: { value: BANK } }, account: BANK },
    Transfer: { entity: transfer("1", 100, BANK, "40"), account: BANK },
  };

  it("has a working extractor case for every type it lists", () => {
    // The list and the switch used to live in two different files, which is how
    // BillPayment ended up missing from both. This asserts they cannot drift.
    const cache = makeCache();
    const dead: string[] = [];
    for (const { type } of POSTING_ENTITY_TYPES) {
      const p = probe[type];
      if (!p) { dead.push(`${type} (no probe fixture — add one)`); continue; }
      const lines = extractAccountLines([p.entity], type, p.account, cache);
      if (!lines.some(l => l.isMatchingLine)) dead.push(`${type} (extractor produced no matching line)`);
    }
    expect(dead).toEqual([]);
  });

  it("covers the entity types that were silently missing", () => {
    const types = POSTING_ENTITY_TYPES.map(e => e.type);
    expect(types).toEqual(expect.arrayContaining([
      "BillPayment", "Transfer", "VendorCredit", "CreditMemo", "RefundReceipt",
    ]));
  });
});
