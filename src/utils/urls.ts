// URL generation utilities for QuickBooks Online

// Keep in step with POSTING_ENTITY_TYPES in src/query/account-transactions.ts —
// a type missing here still appears in results, just with no link to click.
const TXN_URL_MAP: Record<string, string> = {
  journalentry: "journal",
  purchase: "expense",
  deposit: "deposit",
  salesreceipt: "salesreceipt",
  bill: "bill",
  billpayment: "billpayment",
  vendorcredit: "vendorcredit",
  invoice: "invoice",
  payment: "payment",
  creditmemo: "creditmemo",
  refundreceipt: "refundreceipt",
  transfer: "transfer",
};

// Name entities use nameId= instead of txnId=
const NAME_URL_MAP: Record<string, string> = {
  customer: "customerdetail",
};

export function getQboUrl(entityType: string, id: string): string | null {
  const key = entityType.toLowerCase();
  const txnPath = TXN_URL_MAP[key];
  if (txnPath) return `https://app.qbo.intuit.com/app/${txnPath}?txnId=${id}`;
  const namePath = NAME_URL_MAP[key];
  if (namePath) return `https://app.qbo.intuit.com/app/${namePath}?nameId=${id}`;
  return null;
}
