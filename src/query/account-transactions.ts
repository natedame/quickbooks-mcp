// Extract transaction lines that reference a specific account

import { TransactionLine, AccountCache } from "../types/index.js";
import { getQboUrl } from "../utils/index.js";

// Helper type for account reference
interface AccountRef {
  value?: string;
  name?: string;
}

/**
 * Every QuickBooks entity type that posts to the general ledger, paired with its
 * node-quickbooks finder.
 *
 * This is the SINGLE source of truth: `handleQueryAccountTransactions` queries
 * exactly these types and `extractAccountLines` below has a case for each. Keeping
 * the list and the extractor in one file is deliberate — they were previously two
 * parallel lists in two files, so adding a type meant remembering to edit both.
 *
 * Deliberately excluded (non-posting): Estimate, PurchaseOrder, TimeActivity.
 *
 * KNOWN GAP: the `CreditCardPayment` entity (QuickBooks' "Credit Card Payment"
 * transaction) posts to the GL but node-quickbooks exposes no finder for it, so
 * it cannot be queried here. Credit-card accounts that use it will not fully
 * reconcile to the GeneralLedger report.
 */
export const POSTING_ENTITY_TYPES: Array<{ type: string; finder: string }> = [
  { type: 'JournalEntry', finder: 'findJournalEntries' },
  { type: 'Purchase', finder: 'findPurchases' },
  { type: 'Deposit', finder: 'findDeposits' },
  { type: 'SalesReceipt', finder: 'findSalesReceipts' },
  { type: 'Bill', finder: 'findBills' },
  { type: 'BillPayment', finder: 'findBillPayments' },
  { type: 'VendorCredit', finder: 'findVendorCredits' },
  { type: 'Invoice', finder: 'findInvoices' },
  { type: 'Payment', finder: 'findPayments' },
  { type: 'CreditMemo', finder: 'findCreditMemos' },
  { type: 'RefundReceipt', finder: 'findRefundReceipts' },
  { type: 'Transfer', finder: 'findTransfers' },
];

// Get formatted account name from cache or fallback to ref name
function getAccountName(accountId: string, accountCache: AccountCache, refName?: string): string {
  const cached = accountCache.byId.get(accountId);
  if (cached) {
    return cached.AcctNum ? `${cached.AcctNum} ${cached.Name}` : cached.Name;
  }
  return refName || accountId;
}

/**
 * Resolve the company's default account for a given AccountSubType.
 *
 * QuickBooks omits APAccountRef / ARAccountRef / DepositToAccountRef from API
 * responses when the transaction uses the company default (verified: real
 * BillPayment records carry no APAccountRef at all, while Bills do). Without this
 * the A/P side of every bill payment is invisible.
 *
 * Only resolves when exactly ONE active account of that subtype exists, which is
 * the only case where the default is unambiguous. With zero or several, the caller
 * records a warning rather than guessing — a wrong account on financial data is
 * worse than a flagged omission.
 */
export function resolveDefaultAccountId(
  accountCache: AccountCache,
  accountSubType: string,
  accountType: string
): string | undefined {
  const candidates = accountCache.items.filter(
    a => a.Active !== false &&
      (a.AccountSubType === accountSubType ||
        (a.AccountSubType === undefined && a.AccountType === accountType))
  );
  return candidates.length === 1 ? candidates[0].Id : undefined;
}

// Extract ALL transaction lines from transactions that have ANY line matching the target account
// Returns lines with account info and flags for which lines matched the query
export function extractAccountLines(
  entities: Array<Record<string, unknown>>,
  entityType: string,
  targetAccountId: string,
  accountCache: AccountCache,
  departmentFilter?: string,
  warnings?: string[]
): TransactionLine[] {
  const lines: TransactionLine[] = [];

  // Resolved lazily and only once per call — see resolveDefaultAccountId.
  let defaultsResolved = false;
  let defaultApAccountId: string | undefined;
  let defaultArAccountId: string | undefined;
  let defaultUndepositedAccountId: string | undefined;
  const warnedFor = new Set<string>();

  const ensureDefaults = (): void => {
    if (defaultsResolved) return;
    defaultsResolved = true;
    defaultApAccountId = resolveDefaultAccountId(accountCache, 'AccountsPayable', 'Accounts Payable');
    defaultArAccountId = resolveDefaultAccountId(accountCache, 'AccountsReceivable', 'Accounts Receivable');
    defaultUndepositedAccountId = resolveDefaultAccountId(accountCache, 'UndepositedFunds', 'Other Current Asset');
  };

  // Returns the account the entity posts its header side to, falling back to the
  // company default when the ref is absent. Records a warning (never silently
  // drops) when the default cannot be determined.
  const headerAccount = (
    ref: AccountRef | undefined,
    kind: 'AccountsPayable' | 'AccountsReceivable' | 'UndepositedFunds'
  ): string | undefined => {
    if (ref?.value) return ref.value;
    ensureDefaults();
    const resolved =
      kind === 'AccountsPayable' ? defaultApAccountId
        : kind === 'AccountsReceivable' ? defaultArAccountId
          : defaultUndepositedAccountId;
    if (!resolved && warnings && !warnedFor.has(kind)) {
      warnedFor.add(kind);
      warnings.push(
        `${entityType}: could not determine the default ${kind} account (zero or multiple active candidates), ` +
        `so that side of these transactions is not included. Totals for that account may be understated.`
      );
    }
    return resolved;
  };

  for (const entity of entities) {
    const txnId = entity.Id as string;
    const txnDate = entity.TxnDate as string;
    const docNumber = entity.DocNumber as string | undefined;
    const qboLink = getQboUrl(entityType, txnId) || '';

    // Helper to check if a line matches the department filter
    const matchesDepartment = (lineDetail: Record<string, unknown>): boolean => {
      if (!departmentFilter) return true;
      const deptRef = lineDetail.DepartmentRef as { value?: string } | undefined;
      return deptRef?.value === departmentFilter;
    };

    // Helper to get department name from line
    const getDepartment = (lineDetail: Record<string, unknown>): string | undefined => {
      const deptRef = lineDetail.DepartmentRef as { value?: string; name?: string } | undefined;
      return deptRef?.name || deptRef?.value;
    };

    // Extract all lines and check if any match the target account
    const extractedLines: TransactionLine[] = [];
    let hasMatchingLine = false;

    switch (entityType.toLowerCase()) {
      case 'journalentry': {
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.JournalEntryLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          const postingType = detail.PostingType as string;
          const amount = line.Amount as number;
          // Debit = positive, Credit = negative
          const signedAmount = postingType === 'Debit' ? amount : -amount;

          extractedLines.push({
            date: txnDate,
            type: 'JournalEntry',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: signedAmount,
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'purchase': {
        // Header: AccountRef is the bank/credit card account being debited
        const headerAccountRef = entity.AccountRef as AccountRef | undefined;
        const headerAccountId = headerAccountRef?.value || '';
        const headerDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || headerDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Purchase',
            txnId,
            docNumber,
            lineId: 'header',
            amount: -totalAmt, // Credit to bank account
            description: entity.PrivateNote as string | undefined,
            department: headerDeptRef?.name,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, headerAccountRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: AccountBasedExpenseLineDetail for expense accounts
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Purchase',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to expense account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'deposit': {
        // Header: DepositToAccountRef is the bank account being debited
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const headerAccountId = depositToRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Deposit',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to bank account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: DepositLineDetail.AccountRef
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.DepositLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Deposit',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to source account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'salesreceipt': {
        // Header: DepositToAccountRef is the bank account being debited
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const headerAccountId = depositToRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'SalesReceipt',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to bank account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: SalesItemLineDetail - check ItemAccountRef for income account
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          // Check ItemAccountRef (explicit account override on line)
          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue; // Skip lines without explicit account

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          // Get item name for description context
          const itemRef = detail.ItemRef as { name?: string } | undefined;
          const itemName = itemRef?.name;
          const lineDesc = line.Description as string | undefined;
          const description = lineDesc || itemName;

          extractedLines.push({
            date: txnDate,
            type: 'SalesReceipt',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to income account
            description,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'bill': {
        // Header: APAccountRef is the AP account being credited
        const apAccountRef = entity.APAccountRef as AccountRef | undefined;
        const headerAccountId = apAccountRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Bill',
            txnId,
            docNumber,
            lineId: 'header',
            amount: -totalAmt, // Credit to AP
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, apAccountRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: AccountBasedExpenseLineDetail for expense accounts
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Bill',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to expense account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'invoice': {
        // Header: the invoice debits Accounts Receivable. QuickBooks omits
        // ARAccountRef when it is the company default, so fall back to that.
        const arAccountId = headerAccount(entity.ARAccountRef as AccountRef | undefined, 'AccountsReceivable');
        const invoiceDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const invoiceHeaderMatchesDept = !departmentFilter || invoiceDeptRef?.value === departmentFilter;

        if (arAccountId && invoiceHeaderMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = arAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Invoice',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to A/R
            description: entity.PrivateNote as string | undefined,
            department: invoiceDeptRef?.name || invoiceDeptRef?.value,
            qboLink,
            accountId: arAccountId,
            accountName: getAccountName(arAccountId, accountCache, (entity.ARAccountRef as AccountRef | undefined)?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: SalesItemLineDetail - check ItemAccountRef for income account
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          // Check ItemAccountRef (explicit account override on line)
          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue; // Skip lines without explicit account

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          // Get item name for description context
          const itemRef = detail.ItemRef as { name?: string } | undefined;
          const itemName = itemRef?.name;
          const lineDesc = line.Description as string | undefined;
          const description = lineDesc || itemName;

          extractedLines.push({
            date: txnDate,
            type: 'Invoice',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to income account
            description,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'payment': {
        // A customer payment has two sides: it debits the account the money lands
        // in (the bank account, or Undeposited Funds when DepositToAccountRef is
        // omitted) and credits Accounts Receivable.
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const depositAccountId = headerAccount(depositToRef, 'UndepositedFunds');
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;
        const totalAmt = entity.TotalAmt as number;

        if (depositAccountId && headerMatchesDept) {
          const isMatching = depositAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Payment',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to deposit account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: depositAccountId,
            accountName: getAccountName(depositAccountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Credit side: Accounts Receivable (ref omitted when it is the default).
        const paymentArAccountId = headerAccount(entity.ARAccountRef as AccountRef | undefined, 'AccountsReceivable');
        if (paymentArAccountId && headerMatchesDept) {
          const isMatching = paymentArAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Payment',
            txnId,
            docNumber,
            lineId: 'ar',
            amount: -totalAmt, // Credit to A/R
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: paymentArAccountId,
            accountName: getAccountName(paymentArAccountId, accountCache, (entity.ARAccountRef as AccountRef | undefined)?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'billpayment': {
        // A bill payment debits A/P (reducing what is owed) and credits the bank
        // or credit-card account the payment came from.
        //
        // NOTE: entity.Line[] carries only { Amount, LinkedTxn } pointing at the
        // Bills being paid — it holds NO account detail and must never be posted,
        // or the paid Bill's expense lines would be double-counted.
        const totalAmt = entity.TotalAmt as number;
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        // Debit side: A/P. QuickBooks omits APAccountRef when it is the company
        // default, which is the usual case — this fallback is what makes bill
        // payments visible on the A/P account at all.
        const apAccountId = headerAccount(entity.APAccountRef as AccountRef | undefined, 'AccountsPayable');
        if (apAccountId && headerMatchesDept) {
          const isMatching = apAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'BillPayment',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to A/P
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: apAccountId,
            accountName: getAccountName(apAccountId, accountCache, (entity.APAccountRef as AccountRef | undefined)?.name),
            isMatchingLine: isMatching
          });
        }

        // Credit side: the funding account, which depends on PayType.
        const checkPayment = entity.CheckPayment as Record<string, unknown> | undefined;
        const creditCardPayment = entity.CreditCardPayment as Record<string, unknown> | undefined;
        const fundingRef = (checkPayment?.BankAccountRef as AccountRef | undefined)
          || (creditCardPayment?.CCAccountRef as AccountRef | undefined);
        const fundingAccountId = fundingRef?.value || '';

        if (fundingAccountId && headerMatchesDept) {
          const isMatching = fundingAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'BillPayment',
            txnId,
            docNumber,
            lineId: 'funding',
            amount: -totalAmt, // Credit to bank / credit card
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: fundingAccountId,
            accountName: getAccountName(fundingAccountId, accountCache, fundingRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'transfer': {
        // Money moving between two of your own accounts: the destination is
        // debited and the source credited. Transfers carry no department.
        const amount = entity.Amount as number;
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerMatchesDept) {
          const sides: Array<{ ref?: AccountRef; sign: number; lineId: string }> = [
            { ref: entity.ToAccountRef as AccountRef | undefined, sign: 1, lineId: 'to' },
            { ref: entity.FromAccountRef as AccountRef | undefined, sign: -1, lineId: 'from' },
          ];

          for (const side of sides) {
            const accountId = side.ref?.value || '';
            if (!accountId) continue;

            const isMatching = accountId === targetAccountId;
            if (isMatching) hasMatchingLine = true;

            extractedLines.push({
              date: txnDate,
              type: 'Transfer',
              txnId,
              docNumber,
              lineId: side.lineId,
              amount: side.sign * amount,
              description: entity.PrivateNote as string | undefined,
              department: txnDeptRef?.name || txnDeptRef?.value,
              qboLink,
              accountId,
              accountName: getAccountName(accountId, accountCache, side.ref?.name),
              isMatchingLine: isMatching
            });
          }
        }
        break;
      }

      case 'vendorcredit': {
        // The reverse of a Bill: debits A/P (reducing what is owed) and credits
        // the expense accounts. Line amounts can legitimately be negative, so the
        // sign is a uniform flip of the raw amount rather than a negation of its
        // magnitude.
        const apAccountId = headerAccount(entity.APAccountRef as AccountRef | undefined, 'AccountsPayable');
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (apAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = apAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'VendorCredit',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to A/P
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: apAccountId,
            accountName: getAccountName(apAccountId, accountCache, (entity.APAccountRef as AccountRef | undefined)?.name),
            isMatchingLine: isMatching
          });
        }

        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'VendorCredit',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to expense account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'creditmemo': {
        // The reverse of an Invoice: credits A/R and debits the income accounts.
        const arAccountId = headerAccount(entity.ARAccountRef as AccountRef | undefined, 'AccountsReceivable');
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (arAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = arAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'CreditMemo',
            txnId,
            docNumber,
            lineId: 'header',
            amount: -totalAmt, // Credit to A/R
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: arAccountId,
            accountName: getAccountName(arAccountId, accountCache, (entity.ARAccountRef as AccountRef | undefined)?.name),
            isMatchingLine: isMatching
          });
        }

        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          // SubTotalLineDetail lines restate the total and must be skipped.
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue;

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          const itemRef = detail.ItemRef as { name?: string } | undefined;
          const description = (line.Description as string | undefined) || itemRef?.name;

          extractedLines.push({
            date: txnDate,
            type: 'CreditMemo',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to income account
            description,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'refundreceipt': {
        // The reverse of a SalesReceipt: credits the account the money is refunded
        // from and debits the income accounts.
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const headerAccountId = depositToRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'RefundReceipt',
            txnId,
            docNumber,
            lineId: 'header',
            amount: -totalAmt, // Credit to the refunding account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }

        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue;

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          const itemRef = detail.ItemRef as { name?: string } | undefined;
          const description = (line.Description as string | undefined) || itemRef?.name;

          extractedLines.push({
            date: txnDate,
            type: 'RefundReceipt',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to income account
            description,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }
    }

    // Only include lines from transactions that have at least one matching line
    if (hasMatchingLine) {
      lines.push(...extractedLines);
    }
  }

  return lines;
}
