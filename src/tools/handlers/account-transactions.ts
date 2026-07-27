// Handler for query_account_transactions tool

import QuickBooks from "node-quickbooks";
import {
  resolveAccount,
  getDepartmentCache,
  getAccountCache,
} from "../../client/index.js";
import { toCents, sumCents, toDollars, outputReport, isHttpMode } from "../../utils/index.js";
import { PaginationParams } from "../../types/index.js";
import { paginatedQuery, extractAccountLines, mapWithConcurrency, POSTING_ENTITY_TYPES } from "../../query/index.js";
import { TransactionLine } from "../../types/index.js";

// Group transactions by unique transaction key (type:txnId)
interface GroupedTransaction {
  type: string;
  txnId: string;
  docNumber?: string;
  date: string;
  department?: string;
  qboLink: string;
  lines: TransactionLine[];
}

function groupTransactionLines(lines: TransactionLine[]): GroupedTransaction[] {
  const groups = new Map<string, GroupedTransaction>();

  for (const line of lines) {
    const key = `${line.type}:${line.txnId}`;

    if (!groups.has(key)) {
      groups.set(key, {
        type: line.type,
        txnId: line.txnId,
        docNumber: line.docNumber,
        date: line.date,
        department: line.department,
        qboLink: line.qboLink,
        lines: []
      });
    }

    groups.get(key)!.lines.push(line);
  }

  // Convert to array and sort by date
  const result = Array.from(groups.values());
  result.sort((a, b) => a.date.localeCompare(b.date));

  return result;
}

export async function handleQueryAccountTransactions(
  client: QuickBooks,
  args: {
    account: string;
    start_date?: string;
    end_date?: string;
    department?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { account, start_date, end_date, department } = args;

  // Resolve account using cache
  const resolvedAccount = await resolveAccount(client, account);

  // Get account cache for name lookups
  const accountCache = await getAccountCache(client);

  // Resolve department if provided using cache
  let resolvedDepartmentId: string | undefined;
  let resolvedDepartmentName: string | undefined;
  if (department) {
    const deptCache = await getDepartmentCache(client);

    // Try exact ID match
    let deptMatch = deptCache.byId.get(department);

    // Try exact name match (case-insensitive)
    if (!deptMatch) {
      deptMatch = deptCache.byName.get(department.toLowerCase());
    }

    // Try partial match on FullyQualifiedName
    if (!deptMatch) {
      deptMatch = deptCache.items.find(d =>
        d.FullyQualifiedName?.toLowerCase().includes(department.toLowerCase())
      );
    }

    if (deptMatch) {
      resolvedDepartmentId = deptMatch.Id;
      resolvedDepartmentName = deptMatch.Name;
    } else {
      throw new Error(`Department not found: "${department}"`);
    }
  }

  // Build date range
  const today = new Date().toISOString().split('T')[0];
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const startDateResolved = start_date || yearStart;
  const endDateResolved = end_date || today;

  // Build date filter for QB query
  const dateFilter = `TxnDate >= '${startDateResolved}' AND TxnDate <= '${endDateResolved}'`;

  // Anything that made this result less than complete. Surfaced to the caller
  // rather than swallowed — a silently partial transaction list reads as fact.
  const warnings: string[] = [];

  // Query every general-ledger-posting entity type. POSTING_ENTITY_TYPES is the
  // single source of truth, defined alongside the extractor that handles each type.
  //
  // Concurrency is capped because QuickBooks rejects bursts of parallel requests
  // per realm with 429s; firing all twelve at once reliably trips it.
  const ENTITY_QUERY_CONCURRENCY = 4;

  const queryResults = await mapWithConcurrency(
    POSTING_ENTITY_TYPES,
    ENTITY_QUERY_CONCURRENCY,
    async ({ type, finder }) => {
      const pagination: PaginationParams = {
        maxResults: 10000,  // Use full SAFETY_LIMIT for account transaction queries
        startPosition: null, // Auto-paginate
        baseCriteria: `WHERE ${dateFilter}`
      };
      try {
        const result = await paginatedQuery(client, finder as keyof QuickBooks, pagination);
        return { type, entities: result.entities as Array<Record<string, unknown>> };
      } catch (err) {
        // A failed entity type used to be silently treated as "no transactions",
        // which is indistinguishable from a genuinely empty result. Report it.
        warnings.push(
          `${type}: query failed (${err instanceof Error ? err.message : String(err)}), ` +
          `so ${type} transactions are missing from these totals.`
        );
        return { type, entities: [] };
      }
    }
  );

  // Extract lines matching the account from each entity type
  const allLines: TransactionLine[] = [];
  for (const { type, entities } of queryResults) {
    const lines = extractAccountLines(
      entities,
      type,
      resolvedAccount.Id,
      accountCache,
      resolvedDepartmentId,
      warnings
    );
    allLines.push(...lines);
  }

  // Transfers and bill payments carry no department in QuickBooks, so a
  // department filter necessarily excludes them.
  if (resolvedDepartmentId) {
    warnings.push(
      'Transfer and BillPayment transactions are not department-trackable in QuickBooks ' +
      'and are therefore excluded while a department filter is applied.'
    );
  }

  // Sort by date (oldest first)
  allLines.sort((a, b) => a.date.localeCompare(b.date));

  // Group lines by transaction
  const groupedTransactions = groupTransactionLines(allLines);

  // Calculate summary stats using cents for precision
  // Only count matching lines for summary (avoid double-counting)
  const matchingLines = allLines.filter(l => l.isMatchingLine);
  const totalDebitsCents = sumCents(
    matchingLines.filter(l => l.amount > 0).map(l => toCents(l.amount))
  );
  const totalCreditsCents = sumCents(
    matchingLines.filter(l => l.amount < 0).map(l => toCents(Math.abs(l.amount)))
  );
  const netChangeCents = totalDebitsCents - totalCreditsCents;

  // Convert back to dollars for display/storage
  const totalDebits = toDollars(totalDebitsCents);
  const totalCredits = toDollars(totalCreditsCents);
  const netChange = toDollars(netChangeCents);

  // Build report data with grouped view
  const groupedByTransaction: Record<string, {
    type: string;
    docNumber?: string;
    date: string;
    department?: string;
    qboLink: string;
    lines: Array<{
      lineId: string;
      accountId: string;
      accountName: string;
      amount: number;
      description?: string;
      isMatchingLine: boolean;
    }>;
  }> = {};

  for (const txn of groupedTransactions) {
    const key = `${txn.type}:${txn.txnId}`;
    groupedByTransaction[key] = {
      type: txn.type,
      docNumber: txn.docNumber,
      date: txn.date,
      department: txn.department,
      qboLink: txn.qboLink,
      lines: txn.lines.map(l => ({
        lineId: l.lineId,
        accountId: l.accountId,
        accountName: l.accountName,
        amount: l.amount,
        description: l.description,
        isMatchingLine: l.isMatchingLine
      }))
    };
  }

  // In HTTP mode, cap transaction detail to avoid context bloat.
  // Summary is always computed from the full dataset.
  const HTTP_TXN_LIMIT = 100;
  const truncated = isHttpMode() && allLines.length > HTTP_TXN_LIMIT;

  const outputLines = truncated ? allLines.slice(0, HTTP_TXN_LIMIT) : allLines;
  const outputGrouped: typeof groupedByTransaction = {};
  if (truncated) {
    // Only include groups that have at least one line in the truncated set
    const truncatedTxnKeys = new Set(outputLines.map(l => `${l.type}:${l.txnId}`));
    for (const [key, value] of Object.entries(groupedByTransaction)) {
      if (truncatedTxnKeys.has(key)) outputGrouped[key] = value;
    }
  } else {
    Object.assign(outputGrouped, groupedByTransaction);
  }

  const reportData = {
    account: {
      id: resolvedAccount.Id,
      acctNum: resolvedAccount.AcctNum,
      name: resolvedAccount.FullyQualifiedName || resolvedAccount.Name,
      type: resolvedAccount.AccountType,
      currentBalance: resolvedAccount.CurrentBalance
    },
    dateRange: {
      start: startDateResolved,
      end: endDateResolved
    },
    department: resolvedDepartmentId ? {
      id: resolvedDepartmentId,
      name: resolvedDepartmentName
    } : undefined,
    summary: {
      transactionCount: groupedTransactions.length,
      matchingLineCount: matchingLines.length,
      totalDebits,
      totalCredits,
      netChange
    },
    transactions: outputLines,
    groupedByTransaction: outputGrouped,
    ...(warnings.length ? { warnings } : {}),
    ...(truncated ? { truncatedAt: HTTP_TXN_LIMIT, totalLines: allLines.length } : {}),
  };

  // Build summary for display
  const formatCurrency = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const summaryLines = [
    'Account Transaction Query',
    '=========================',
    `Account: ${resolvedAccount.AcctNum ? `${resolvedAccount.AcctNum} ` : ''}${resolvedAccount.FullyQualifiedName || resolvedAccount.Name} (${resolvedAccount.AccountType})`,
    `Period: ${startDateResolved} to ${endDateResolved}`,
  ];

  if (resolvedDepartmentName) {
    summaryLines.push(`Department: ${resolvedDepartmentName}`);
  }

  summaryLines.push('');
  summaryLines.push(`Summary: ${groupedTransactions.length} transactions | Debits: ${formatCurrency(totalDebits)} | Credits: ${formatCurrency(totalCredits)} | Net: ${netChange >= 0 ? '' : '-'}${formatCurrency(netChange)}`);

  if (truncated) {
    summaryLines.push(`(Showing first ${HTTP_TXN_LIMIT} of ${allLines.length} transaction lines in detail)`);
  }

  if (warnings.length) {
    summaryLines.push('');
    summaryLines.push('INCOMPLETE - this result is missing data:');
    for (const w of warnings) {
      summaryLines.push(`  ! ${w}`);
    }
  }

  if (groupedTransactions.length > 0) {
    summaryLines.push('');
    summaryLines.push('Recent (first 5 transactions):');
    summaryLines.push('');

    for (const txn of groupedTransactions.slice(0, 5)) {
      const docNum = txn.docNumber ? ` #${txn.docNumber}` : '';
      const dept = txn.department ? ` [${txn.department}]` : '';

      // Calculate total for transaction (sum of absolute values / 2 for balanced transactions)
      const txnDebits = txn.lines.filter(l => l.amount > 0).reduce((sum, l) => sum + l.amount, 0);

      summaryLines.push(`${txn.type}${docNum} (${txn.date}) - ${formatCurrency(txnDebits)} total${dept}`);

      // Show all lines with arrow for matching lines
      for (const line of txn.lines) {
        const indicator = line.isMatchingLine ? '→' : ' ';
        const amountStr = line.amount >= 0
          ? `${formatCurrency(line.amount).padStart(12)}  debit`
          : `${formatCurrency(line.amount).padStart(12)}  credit`;
        const desc = line.description ? `  ${line.description.substring(0, 25)}${line.description.length > 25 ? '...' : ''}` : '';
        summaryLines.push(`  ${indicator} ${line.accountName.padEnd(28)} ${amountStr}${desc}`);
      }
      summaryLines.push('');
    }
  }

  return outputReport('account-transactions', reportData, summaryLines.join('\n'));
}
