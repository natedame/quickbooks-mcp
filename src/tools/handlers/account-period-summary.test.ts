// Unit tests for parseGLReport (GEN-7941). Closing balance used to be whatever the
// LAST Data row's Balance column happened to hold, which made it depend on row
// order — and Intuit's modernized GeneralLedger response reorders rows within a
// same-date group. It is now derived as opening balance plus net activity, which
// no ordering can change.
//
// The fixtures are trimmed from real GeneralLedger responses for this company.

import { describe, it, expect } from "vitest";
import { parseGLReport } from "./account-period-summary.js";

const COLUMNS = {
  Column: [
    { ColTitle: "Date" }, { ColTitle: "Transaction Type" }, { ColTitle: "Num" },
    { ColTitle: "Name" }, { ColTitle: "Memo/Description" }, { ColTitle: "Split" },
    { ColTitle: "Amount" }, { ColTitle: "Balance" },
  ],
};

function dataRow(date: string, type: string, amount: string, balance: string) {
  return {
    type: "Data",
    ColData: [
      { value: date }, { value: type }, { value: "" }, { value: "" },
      { value: "" }, { value: "" }, { value: amount }, { value: balance },
    ],
  };
}

function beginningBalance(balance: string) {
  return {
    type: "Data",
    ColData: [
      { value: "Beginning Balance" }, { value: "" }, { value: "" }, { value: "" },
      { value: "" }, { value: "" }, { value: "" }, { value: balance },
    ],
  };
}

function section(header: string, rows: unknown[]) {
  return { type: "Section", Header: { ColData: [{ value: header }] }, Rows: { Row: rows } };
}

// Account 20000 Accounts Payable, 2026-01-01..2026-07-27, verbatim from the report.
function apReport(rows?: unknown[]) {
  const txns = rows ?? [
    dataRow("2026-01-20", "Bill", "630.00", "4278.75"),
    dataRow("2026-01-28", "Bill Payment (Credit Card)", "-630.00", "3648.75"),
    dataRow("2026-01-28", "Bill Payment (Credit Card)", "-922.50", "2726.25"),
    dataRow("2026-01-28", "Bill Payment (Credit Card)", "-2351.25", "375.00"),
    dataRow("2026-01-31", "Bill", "200.00", "575.00"),
    dataRow("2026-03-01", "Bill Payment (Check)", "-575.00", ".00"),
    dataRow("2026-04-01", "Bill", "400.00", "400.00"),
    dataRow("2026-04-01", "Bill", "350.00", "750.00"),
    dataRow("2026-04-30", "Bill", "550.00", "1300.00"),
    dataRow("2026-05-01", "Bill", "26.00", "1326.00"),
  ];
  return {
    Columns: COLUMNS,
    Rows: { Row: [section("20000 Accounts Payable", [beginningBalance("3648.75"), ...txns])] },
  };
}

describe("parseGLReport", () => {
  it("matches the live A/P period", () => {
    expect(parseGLReport(apReport())).toEqual({
      openingBalance: 3648.75,
      closingBalance: 1326,
      totalDebits: 4478.75,
      totalCredits: 2156,
      netActivity: -2322.75,
      transactionCount: 10,
    });
  });

  it("gives the same closing balance when same-date rows are reordered", () => {
    // The exact reordering Intuit performs: the two 2026-01-28 bill payments swap,
    // which changes every running-balance value between them. The Balance column
    // values below are what the report would then carry.
    const shuffled = [
      dataRow("2026-01-20", "Bill", "630.00", "4278.75"),
      dataRow("2026-01-28", "Bill Payment (Credit Card)", "-922.50", "3356.25"),
      dataRow("2026-01-28", "Bill Payment (Credit Card)", "-630.00", "2726.25"),
      dataRow("2026-01-28", "Bill Payment (Credit Card)", "-2351.25", "375.00"),
      dataRow("2026-01-31", "Bill", "200.00", "575.00"),
      dataRow("2026-03-01", "Bill Payment (Check)", "-575.00", ".00"),
      dataRow("2026-04-01", "Bill", "400.00", "400.00"),
      dataRow("2026-04-01", "Bill", "350.00", "750.00"),
      dataRow("2026-04-30", "Bill", "550.00", "1300.00"),
      dataRow("2026-05-01", "Bill", "26.00", "1326.00"),
    ];
    expect(parseGLReport(apReport(shuffled))).toEqual(parseGLReport(apReport()));
  });

  it("is unmoved even if the FINAL row group reorders", () => {
    // The case the old implementation could not survive: the last row changes, so
    // the Balance column it used to read is no longer the account's closing figure.
    const rows = [
      dataRow("2026-01-20", "Bill", "630.00", "4278.75"),
      dataRow("2026-01-28", "Bill Payment (Credit Card)", "-630.00", "3648.75"),
      dataRow("2026-01-28", "Bill Payment (Credit Card)", "-922.50", "2726.25"),
      dataRow("2026-01-28", "Bill Payment (Credit Card)", "-2351.25", "375.00"),
      dataRow("2026-01-31", "Bill", "200.00", "575.00"),
      dataRow("2026-03-01", "Bill Payment (Check)", "-575.00", ".00"),
      dataRow("2026-04-01", "Bill", "400.00", "400.00"),
      dataRow("2026-04-01", "Bill", "350.00", "750.00"),
      // final same-date group swapped; running balances follow the new order
      dataRow("2026-05-01", "Bill", "26.00", "776.00"),
      dataRow("2026-04-30", "Bill", "550.00", "1326.00"),
    ];
    expect(parseGLReport(apReport(rows)).closingBalance).toBe(1326);

    // ...and it holds even when the trailing Balance value is outright absent.
    const noTrailingBalance = [...rows.slice(0, -1), dataRow("2026-04-30", "Bill", "550.00", "")];
    expect(parseGLReport(apReport(noTrailingBalance)).closingBalance).toBe(1326);
  });

  it("reports a parent account's own balance, not the last child section's", () => {
    // Account 21000 Chase Credit, 2025. The report ends inside the "Nate CC" child
    // section whose activity nets to zero, so the last Balance column reads .00 —
    // the old implementation returned 0.00 here. The Balance Sheet at 2025-12-31
    // puts 21000 Chase Credit at 10,061.67.
    const report = {
      Columns: COLUMNS,
      Rows: {
        Row: [
          section("21000 Chase Credit", [
            beginningBalance("5100.71"),
            dataRow("2025-06-01", "Expense", "4960.96", "10061.67"),
            section("8397 Nate CC", [
              // Child activity nets to zero, as it does in the real report.
              dataRow("2025-12-31", "Expense", "294.00", "294.00"),
              dataRow("2025-12-31", "Journal Entry", "-828.41", "-534.41"),
              dataRow("2025-12-31", "Expense", "63.24", "-471.17"),
              dataRow("2025-12-31", "Expense", "471.17", ".00"),
            ]),
          ]),
        ],
      },
    };
    expect(parseGLReport(report).closingBalance).toBe(10061.67);
  });

  it("treats a missing Beginning Balance row as an opening of zero", () => {
    // Verified across 15 real reports: QuickBooks omits the row only when the
    // opening balance genuinely is zero.
    const report = {
      Columns: COLUMNS,
      Rows: { Row: [section("8397 Nate CC", [dataRow("2026-01-05", "Expense", "56391.76", "56391.76")])] },
    };
    expect(parseGLReport(report)).toMatchObject({
      openingBalance: 0,
      closingBalance: 56391.76,
      transactionCount: 1,
    });
  });

  it("returns the opening balance for a period with no transactions", () => {
    const report = {
      Columns: COLUMNS,
      Rows: { Row: [section("20000 Accounts Payable", [beginningBalance("3648.75")])] },
    };
    expect(parseGLReport(report)).toEqual({
      openingBalance: 3648.75,
      closingBalance: 3648.75,
      totalDebits: 0,
      totalCredits: 0,
      netActivity: 0,
      transactionCount: 0,
    });
  });

  it("handles an entirely empty report", () => {
    expect(parseGLReport({ Columns: COLUMNS, Rows: { Row: [] } })).toEqual({
      openingBalance: 0,
      closingBalance: 0,
      totalDebits: 0,
      totalCredits: 0,
      netActivity: 0,
      transactionCount: 0,
    });
  });

  it("ignores zero-amount rows when counting transactions", () => {
    const report = apReport([
      dataRow("2026-01-20", "Bill", "630.00", "4278.75"),
      dataRow("2026-01-21", "Bill", "0.00", "4278.75"),
    ]);
    expect(parseGLReport(report)).toMatchObject({ transactionCount: 1, closingBalance: 4278.75 });
  });
});
