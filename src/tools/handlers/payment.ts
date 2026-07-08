// Handler for create_payment — apply a received customer payment against one or
// more open invoices, marking them paid.
//
// SAFETY MODEL (this is a real-money bookkeeping write, so every guard matters):
//  - draft=true by DEFAULT: previews, writes nothing, until called with draft=false.
//  - The tool NAME must start with create_/edit_/delete_ so the read-only write-gate
//    (serverFactory.ts) classifies it as a write. `create_payment` satisfies that;
//    a startup assertion (definitions.ts WRITE_TOOLS) enforces it for future tools.
//  - Cross-customer HARD FAIL: every targeted invoice must belong to the named customer.
//  - LIVE per-invoice open-balance re-check (not cached): this is the idempotency guard —
//    an already-paid invoice (Balance 0) is refused, so a double-run cannot double-apply.
//  - Cents-safe: an applied amount can never exceed an invoice's current open balance.
//  - No money ever moves in the real world. QuickBooks is a ledger; this only records
//    that a payment which already arrived (e.g. the Repay ACH) settles an invoice.
//  - Recovery is the QuickBooks UI (edit/delete deliberately not built here — least privilege).

import QuickBooks from "node-quickbooks";
import {
  promisify,
  resolveCustomer,
  resolveAccount,
  resolveInvoiceByDocNumber,
  getInvoiceSummaryById,
  type InvoiceSummary,
} from "../../client/index.js";
import { validateAmount, toCents, toDollars, formatDollars, sumCents } from "../../utils/index.js";

interface PaymentInvoiceInput {
  invoice_id?: string;
  doc_number?: string;
  /** Amount to apply to THIS invoice. Omit to apply the full current open balance. */
  amount?: number;
}

interface ResolvedApplication {
  inv: InvoiceSummary;
  applyCents: number;
}

export async function handleCreatePayment(
  client: QuickBooks,
  args: {
    customer_name?: string;
    customer_id?: string;
    invoices: PaymentInvoiceInput[];
    txn_date: string;
    deposit_to_account?: string; // omit -> Undeposited Funds (correct for the Repay ACH batches)
    payment_ref?: string; // e.g. the Repay ACH reference
    memo?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    customer_name,
    customer_id,
    invoices,
    txn_date,
    deposit_to_account,
    payment_ref,
    memo,
    draft = true,
  } = args;

  if (!invoices || invoices.length === 0) {
    throw new Error("At least one invoice to apply the payment to is required.");
  }
  if (!customer_name && !customer_id) {
    throw new Error("Either customer_name or customer_id is required.");
  }
  if (!txn_date) {
    throw new Error("txn_date is required (YYYY-MM-DD).");
  }

  // Resolve the customer the payment is FROM.
  const customerRef = await resolveCustomer(client, customer_id || customer_name!);

  // Resolve the optional deposit account (omit -> Undeposited Funds).
  let depositRef: { value: string; name: string } | undefined;
  if (deposit_to_account) {
    const acct = await resolveAccount(client, deposit_to_account);
    depositRef = { value: acct.Id, name: acct.FullyQualifiedName || acct.Name };
  }

  // Resolve every invoice LIVE and validate each against its fresh open balance.
  const resolved: ResolvedApplication[] = [];
  for (let i = 0; i < invoices.length; i++) {
    const inp = invoices[i];
    const label = `Invoice ${i + 1}`;

    let inv: InvoiceSummary;
    if (inp.invoice_id) {
      inv = await getInvoiceSummaryById(client, inp.invoice_id);
    } else if (inp.doc_number) {
      inv = await resolveInvoiceByDocNumber(client, inp.doc_number);
    } else {
      throw new Error(`${label}: either invoice_id or doc_number is required.`);
    }
    const ref = `#${inv.DocNumber || inv.Id}`;

    // Cross-customer HARD FAIL.
    if (inv.CustomerRef.value !== customerRef.value) {
      throw new Error(
        `${label} (${ref}) belongs to customer "${inv.CustomerRef.name || inv.CustomerRef.value}", ` +
          `not "${customerRef.name}". Refusing to apply a payment across customers.`
      );
    }

    // LIVE balance re-check = idempotency guard.
    const balanceCents = toCents(inv.Balance);
    if (balanceCents <= 0) {
      throw new Error(
        `${label} (${ref}) has no open balance ($${inv.Balance.toFixed(2)}) — it is already paid. ` +
          `Refusing to double-apply.`
      );
    }

    // Applied amount: explicit (validated <= balance) or the full open balance.
    let applyCents: number;
    if (inp.amount !== undefined) {
      applyCents = validateAmount(inp.amount, `${label} amount`);
      if (applyCents <= 0) {
        throw new Error(`${label}: amount must be positive.`);
      }
      if (applyCents > balanceCents) {
        throw new Error(
          `${label} (${ref}): amount $${inp.amount.toFixed(2)} exceeds the open balance ` +
            `$${inv.Balance.toFixed(2)}. Refusing to overpay an invoice.`
        );
      }
    } else {
      applyCents = balanceCents;
    }

    resolved.push({ inv, applyCents });
  }

  const totalCents = sumCents(resolved.map((r) => r.applyCents));

  // Build the QuickBooks Payment object. Each line links to exactly one invoice.
  const paymentObject: Record<string, unknown> = {
    CustomerRef: { value: customerRef.value },
    TotalAmt: toDollars(totalCents),
    TxnDate: txn_date,
    ...(payment_ref && { PaymentRefNum: payment_ref }),
    ...(memo && { PrivateNote: memo }),
    ...(depositRef && { DepositToAccountRef: { value: depositRef.value } }),
    Line: resolved.map((r) => ({
      Amount: toDollars(r.applyCents),
      LinkedTxn: [{ TxnId: r.inv.Id, TxnType: "Invoice" }],
    })),
  };

  if (draft) {
    const preview = [
      "DRAFT - Customer Payment Preview",
      "",
      `From customer: ${customerRef.name}`,
      `Date: ${txn_date}`,
      `Deposit to: ${depositRef ? depositRef.name : "Undeposited Funds (default)"}`,
      `Reference: ${payment_ref || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      "",
      "Applying to:",
      ...resolved.map((r) => {
        const ref = `#${r.inv.DocNumber || r.inv.Id}`;
        const remainingCents = toCents(r.inv.Balance) - r.applyCents;
        const remainingStr =
          remainingCents > 0 ? ` (remaining after: $${formatDollars(remainingCents)})` : " (paid in full)";
        return `  Invoice ${ref}: apply $${formatDollars(r.applyCents)} of $${r.inv.Balance.toFixed(2)} open${remainingStr}`;
      }),
      "  ─────────────",
      `  Total payment: $${formatDollars(totalCents)}`,
      "",
      "Set draft=false to record this payment.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = (await promisify<unknown>((cb) => client.createPayment(paymentObject, cb))) as {
    Id: string;
  };

  const qboUrl = `https://app.qbo.intuit.com/app/recvpayment?txnId=${result.Id}`;
  const response = [
    "Payment Recorded!",
    "",
    `ID: ${result.Id}`,
    `From customer: ${customerRef.name}`,
    `Date: ${txn_date}`,
    `Deposit to: ${depositRef ? depositRef.name : "Undeposited Funds"}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    "Applied to:",
    ...resolved.map((r) => `  Invoice #${r.inv.DocNumber || r.inv.Id}: $${formatDollars(r.applyCents)}`),
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}
