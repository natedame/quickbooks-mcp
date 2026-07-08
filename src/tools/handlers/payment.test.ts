// Unit tests for create_payment — the money-safety guards. QuickBooks is mocked;
// no network, no real books. Every guard that protects live money is exercised.

import { vi, describe, it, expect, beforeEach } from "vitest";

const resolveCustomer = vi.fn();
const resolveInvoiceByDocNumber = vi.fn();
const getInvoiceSummaryById = vi.fn();
const resolveAccount = vi.fn();

vi.mock("../../client/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual, // keep the real promisify
    resolveCustomer: (...a: unknown[]) => resolveCustomer(...a),
    resolveInvoiceByDocNumber: (...a: unknown[]) => resolveInvoiceByDocNumber(...a),
    getInvoiceSummaryById: (...a: unknown[]) => getInvoiceSummaryById(...a),
    resolveAccount: (...a: unknown[]) => resolveAccount(...a),
  };
});

import { handleCreatePayment } from "./payment.js";

interface Captured {
  obj?: Record<string, unknown>;
}
// A fake QuickBooks client that records the payload and never touches a network.
function makeClient(captured: Captured) {
  return {
    createPayment: (obj: Record<string, unknown>, cb: (e: unknown, r: unknown) => void) => {
      captured.obj = obj;
      cb(null, { Id: "PMT99" });
    },
  } as unknown as import("node-quickbooks");
}

const CUSTOMER = { value: "C1", name: "Arthritis Foundation" };
function inv(overrides: Partial<{ Id: string; DocNumber: string; customer: string; Balance: number; TotalAmt: number }> = {}) {
  return {
    Id: overrides.Id ?? "I1",
    DocNumber: overrides.DocNumber ?? "4315",
    CustomerRef: { value: overrides.customer ?? "C1", name: "Arthritis Foundation" },
    Balance: overrides.Balance ?? 100,
    TotalAmt: overrides.TotalAmt ?? 100,
  };
}

describe("handleCreatePayment guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCustomer.mockResolvedValue(CUSTOMER);
  });

  it("HARD-FAILS applying across customers", async () => {
    resolveInvoiceByDocNumber.mockResolvedValue(inv({ customer: "C2" }));
    const captured: Captured = {};
    await expect(
      handleCreatePayment(makeClient(captured), {
        customer_name: "Arthritis Foundation",
        invoices: [{ doc_number: "4315" }],
        txn_date: "2026-07-08",
        draft: false,
      })
    ).rejects.toThrow(/across customers/i);
    expect(captured.obj).toBeUndefined(); // never wrote
  });

  it("REFUSES an already-paid invoice (idempotency guard)", async () => {
    resolveInvoiceByDocNumber.mockResolvedValue(inv({ Balance: 0 }));
    await expect(
      handleCreatePayment(makeClient({}), {
        customer_name: "Arthritis Foundation",
        invoices: [{ doc_number: "4315" }],
        txn_date: "2026-07-08",
        draft: false,
      })
    ).rejects.toThrow(/already paid/i);
  });

  it("REFUSES to overpay an invoice", async () => {
    resolveInvoiceByDocNumber.mockResolvedValue(inv({ Balance: 50 }));
    await expect(
      handleCreatePayment(makeClient({}), {
        customer_name: "Arthritis Foundation",
        invoices: [{ doc_number: "4315", amount: 60 }],
        txn_date: "2026-07-08",
        draft: false,
      })
    ).rejects.toThrow(/exceeds the open balance/i);
  });

  it("draft=true (default) previews and writes NOTHING", async () => {
    resolveInvoiceByDocNumber.mockResolvedValue(inv({ Balance: 100 }));
    const captured: Captured = {};
    const res = await handleCreatePayment(makeClient(captured), {
      customer_name: "Arthritis Foundation",
      invoices: [{ doc_number: "4315" }],
      txn_date: "2026-07-08",
    });
    const text = res.content[0].text;
    expect(text).toMatch(/DRAFT/);
    expect(text).toMatch(/apply \$100\.00/);
    expect(text).toMatch(/Total payment: \$100\.00/);
    expect(captured.obj).toBeUndefined();
  });

  it("applies the FULL open balance when amount is omitted, and defaults to Undeposited Funds", async () => {
    getInvoiceSummaryById.mockResolvedValue(inv({ Id: "I7", Balance: 250 }));
    const captured: Captured = {};
    await handleCreatePayment(makeClient(captured), {
      customer_id: "C1",
      invoices: [{ invoice_id: "I7" }],
      txn_date: "2026-07-08",
      draft: false,
    });
    expect(captured.obj).toBeDefined();
    expect(captured.obj!.TotalAmt).toBe(250);
    expect(captured.obj!.DepositToAccountRef).toBeUndefined(); // Undeposited Funds
    const line = (captured.obj!.Line as Array<Record<string, unknown>>)[0];
    expect(line.Amount).toBe(250);
    expect(line.LinkedTxn).toEqual([{ TxnId: "I7", TxnType: "Invoice" }]);
  });

  it("sums a multi-invoice payment cents-safely and links each invoice", async () => {
    resolveInvoiceByDocNumber
      .mockResolvedValueOnce(inv({ Id: "I1", DocNumber: "4315", Balance: 60.5 }))
      .mockResolvedValueOnce(inv({ Id: "I2", DocNumber: "4316", Balance: 39.5 }));
    const captured: Captured = {};
    await handleCreatePayment(makeClient(captured), {
      customer_name: "Arthritis Foundation",
      invoices: [{ doc_number: "4315" }, { doc_number: "4316" }],
      txn_date: "2026-07-08",
      draft: false,
    });
    expect(captured.obj!.TotalAmt).toBe(100); // 60.50 + 39.50, no float drift
    const lines = captured.obj!.Line as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0].LinkedTxn).toEqual([{ TxnId: "I1", TxnType: "Invoice" }]);
    expect(lines[1].LinkedTxn).toEqual([{ TxnId: "I2", TxnType: "Invoice" }]);
  });

  it("routes to an explicit deposit account when provided", async () => {
    resolveInvoiceByDocNumber.mockResolvedValue(inv({ Balance: 100 }));
    resolveAccount.mockResolvedValue({ Id: "A5", Name: "Checking", FullyQualifiedName: "Checking" });
    const captured: Captured = {};
    await handleCreatePayment(makeClient(captured), {
      customer_name: "Arthritis Foundation",
      invoices: [{ doc_number: "4315" }],
      txn_date: "2026-07-08",
      deposit_to_account: "Checking",
      draft: false,
    });
    expect(captured.obj!.DepositToAccountRef).toEqual({ value: "A5" });
  });

  it("applies a partial amount and shows the remaining balance in the preview", async () => {
    resolveInvoiceByDocNumber.mockResolvedValue(inv({ Balance: 100 }));
    const res = await handleCreatePayment(makeClient({}), {
      customer_name: "Arthritis Foundation",
      invoices: [{ doc_number: "4315", amount: 30 }],
      txn_date: "2026-07-08",
    });
    expect(res.content[0].text).toMatch(/remaining after: \$70\.00/);
  });

  it("requires at least one invoice and a customer", async () => {
    await expect(
      handleCreatePayment(makeClient({}), { customer_name: "X", invoices: [], txn_date: "2026-07-08" })
    ).rejects.toThrow(/at least one invoice/i);
    await expect(
      handleCreatePayment(makeClient({}), { invoices: [{ doc_number: "4315" }], txn_date: "2026-07-08" })
    ).rejects.toThrow(/customer_name or customer_id/i);
  });
});
