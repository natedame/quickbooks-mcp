// Handler for account_period_summary tool
// Uses the GeneralLedger report to provide opening/closing balances,
// total debits/credits, and transaction count for any account over a date range.

import QuickBooks from "node-quickbooks";
import { resolveAccount, resolveDepartmentId, promisify } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";
import { withThrottleRetry } from "../../query/index.js";
import { QBReport } from "../../types/index.js";

interface GLRowColData {
  value?: string;
  id?: string;
}

interface GLRow {
  type?: string;
  group?: string;
  ColData?: GLRowColData[];
  Summary?: { ColData?: GLRowColData[] };
  Rows?: { Row?: GLRow[] };
  Header?: { ColData?: GLRowColData[] };
}

interface GLReport {
  Header?: QBReport["Header"];
  Columns?: {
    Column?: Array<{ ColTitle?: string; ColType?: string; MetaData?: Array<{ Name: string; Value: string }> }>;
  };
  Rows?: {
    Row?: GLRow[];
  };
}

interface PeriodSummary {
  openingBalance: number;
  closingBalance: number;
  totalDebits: number;
  totalCredits: number;
  netActivity: number;
  transactionCount: number;
}

/**
 * Parse a GeneralLedger report to extract period summary data.
 *
 * GL report structure (nested sections):
 *   Section (parent account) → Section (child account) → Data rows
 *
 * Columns: Date, Transaction Type, Num, Name, Memo/Description, Split, Amount, Balance
 * - "Amount" column: negative = debit, positive = credit
 * - "Balance" column: running balance (present on transaction rows, not on Summary)
 * - "Beginning Balance" row: Balance column has opening balance
 * - Summary row: Amount column has net activity total; Balance column is empty
 * - Closing balance: DERIVED as opening balance plus net activity.
 *
 * Closing balance is deliberately NOT read from the Balance column of the last
 * row. Summing amounts is commutative, so the derived figure is immune to row
 * ordering, and Intuit's modernized GeneralLedger response reorders rows within a
 * same-date group. Reading the last row was also outright wrong for a parent
 * account with sub-accounts: the report ends with the last CHILD section's running
 * balance, not the account's. Verified against the Balance Sheet — for
 * "21000 Chase Credit" at 2025-12-31 the last row reads 0.00 while the true
 * balance is 10,061.67, which is what opening + net activity yields.
 */
export function parseGLReport(report: GLReport): PeriodSummary {
  const columns = report.Columns?.Column ?? [];

  const amountIdx = columns.findIndex(c => c.ColTitle === "Amount");
  const balanceIdx = columns.findIndex(c => c.ColTitle === "Balance");

  let openingBalance = 0;
  let totalDebits = 0;
  let totalCredits = 0;
  let transactionCount = 0;

  const rows = report.Rows?.Row ?? [];

  function processRows(rowList: GLRow[]): void {
    for (const row of rowList) {
      // Recurse into nested sections (parent account → child account)
      if (row.Rows?.Row) {
        processRows(row.Rows.Row);
      }

      // Process Data rows (Beginning Balance + transaction rows)
      if (row.type === "Data" && row.ColData) {
        const colData = row.ColData;
        const firstCol = colData[0]?.value ?? "";

        if (firstCol === "Beginning Balance") {
          if (balanceIdx >= 0 && colData[balanceIdx]?.value) {
            openingBalance += parseFloat(colData[balanceIdx].value!) || 0;
          }
          continue;
        }

        // Transaction row
        const amount = amountIdx >= 0 && colData[amountIdx]?.value
          ? parseFloat(colData[amountIdx].value!) || 0
          : 0;

        if (amount !== 0) {
          transactionCount++;
          if (amount < 0) {
            totalDebits += Math.abs(amount);
          } else {
            totalCredits += amount;
          }
        }
      }
    }
  }

  processRows(rows);

  const netActivity = totalCredits - totalDebits;

  // Order-independent by construction: addition is commutative, so no row
  // ordering can change this. With no transactions it collapses to the opening
  // balance, which is the correct answer for an empty period.
  const closingBalance = openingBalance + netActivity;

  return {
    openingBalance,
    closingBalance,
    totalDebits,
    totalCredits,
    netActivity,
    transactionCount,
  };
}

export async function handleAccountPeriodSummary(
  client: QuickBooks,
  args: {
    account: string;
    start_date?: string;
    end_date?: string;
    department?: string;
    accounting_method?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account, start_date, end_date, department, accounting_method } = args;

  // Resolve account using cache
  const resolvedAccount = await resolveAccount(client, account);

  // Build report options
  const options: Record<string, string> = {
    account: resolvedAccount.Id,
  };

  const today = new Date().toISOString().split("T")[0];
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const startDateResolved = start_date || yearStart;
  const endDateResolved = end_date || today;

  options.start_date = startDateResolved;
  options.end_date = endDateResolved;

  if (department) {
    options.department = await resolveDepartmentId(client, department);
  }
  if (accounting_method) {
    options.accounting_method = accounting_method;
  }

  // Call the GeneralLedger report. Retried through a throttle response so a busy
  // realm surfaces the report rather than a raw 429.
  const report = (await withThrottleRetry(() =>
    promisify<unknown>((cb) => client.reportGeneralLedgerDetail(options, cb))
  )) as GLReport;

  // Parse the report
  const summary = parseGLReport(report);

  // Build summary string
  const formatCurrency = (n: number) => {
    const sign = n < 0 ? "-" : "";
    return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const acctLabel = resolvedAccount.AcctNum
    ? `${resolvedAccount.AcctNum} ${resolvedAccount.FullyQualifiedName || resolvedAccount.Name}`
    : resolvedAccount.FullyQualifiedName || resolvedAccount.Name;

  const summaryLines = [
    "Account Period Summary",
    "======================",
    `Account: ${acctLabel} (${resolvedAccount.AccountType})`,
    `Period: ${startDateResolved} to ${endDateResolved}`,
  ];

  if (department) {
    summaryLines.push(`Department: ${department}`);
  }
  if (accounting_method) {
    summaryLines.push(`Basis: ${accounting_method}`);
  }

  summaryLines.push("");
  summaryLines.push(`Opening Balance:  ${formatCurrency(summary.openingBalance)}`);
  summaryLines.push(`Total Debits:     ${formatCurrency(summary.totalDebits)}`);
  summaryLines.push(`Total Credits:    ${formatCurrency(summary.totalCredits)}`);
  summaryLines.push(`Net Activity:     ${formatCurrency(summary.netActivity)}`);
  summaryLines.push(`Closing Balance:  ${formatCurrency(summary.closingBalance)}`);
  summaryLines.push(`Transactions:     ${summary.transactionCount}`);

  // Build report data
  const reportData = {
    account: {
      id: resolvedAccount.Id,
      acctNum: resolvedAccount.AcctNum,
      name: resolvedAccount.FullyQualifiedName || resolvedAccount.Name,
      type: resolvedAccount.AccountType,
    },
    dateRange: {
      start: startDateResolved,
      end: endDateResolved,
    },
    department: department || undefined,
    accountingMethod: accounting_method || "Accrual",
    summary,
  };

  return outputReport("account-period-summary", reportData, summaryLines.join("\n"));
}
