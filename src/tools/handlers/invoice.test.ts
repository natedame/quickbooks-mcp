// Unit tests for create_invoice — the duplicate-number guard (GEN-5749). QuickBooks is
// mocked; no network, no real books. Proves: omit doc_number -> QBO auto-assigns (no check);
// provide a colliding doc_number -> hard-refused on a real create, warned in a draft preview.

import { vi, describe, it, expect, beforeEach } from "vitest";

const resolveCustomer = vi.fn();
const resolveItem = vi.fn();
const findInvoicesByDocNumber = vi.fn();

vi.mock("../../client/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual, // keep the real promisify
    resolveCustomer: (...a: unknown[]) => resolveCustomer(...a),
    resolveItem: (...a: unknown[]) => resolveItem(...a),
    findInvoicesByDocNumber: (...a: unknown[]) => findInvoicesByDocNumber(...a),
  };
});

import { handleCreateInvoice } from "./invoice.js";

interface Captured {
  obj?: Record<string, unknown>;
}
// A fake QuickBooks client that records the create payload and never touches a network.
function makeClient(captured: Captured) {
  return {
    createInvoice: (obj: Record<string, unknown>, cb: (e: unknown, r: unknown) => void) => {
      captured.obj = obj;
      cb(null, { Id: "INV99", DocNumber: (obj.DocNumber as string) ?? "5000" });
    },
  } as unknown as import("node-quickbooks");
}

// An existing-invoice match as findInvoicesByDocNumber returns it (InvoiceSummary shape).
function match(overrides: Partial<{ Id: string; DocNumber: string; name: string }> = {}) {
  return {
    Id: overrides.Id ?? "56265",
    DocNumber: overrides.DocNumber ?? "4319",
    CustomerRef: { value: "C1", name: overrides.name ?? "Arthritis Foundation" },
    Balance: 100,
    TotalAmt: 100,
  };
}

const BASE = {
  customer_name: "Arthritis Foundation",
  txn_date: "2026-07-09",
  lines: [{ item_name: "SEO", amount: 5300 }],
};

describe("handleCreateInvoice duplicate-number guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCustomer.mockResolvedValue({ value: "C1", name: "Arthritis Foundation" });
    resolveItem.mockResolvedValue({ value: "1", name: "SEO" });
    findInvoicesByDocNumber.mockResolvedValue([]);
  });

  it("omits DocNumber and NEVER checks when doc_number is not provided (QBO auto-assigns)", async () => {
    const captured: Captured = {};
    await handleCreateInvoice(makeClient(captured), { ...BASE, draft: false });
    expect(findInvoicesByDocNumber).not.toHaveBeenCalled();
    expect(captured.obj).toBeDefined();
    expect(captured.obj!.DocNumber).toBeUndefined(); // deferred to QuickBooks
  });

  it("creates with the explicit DocNumber when the number is free", async () => {
    findInvoicesByDocNumber.mockResolvedValue([]);
    const captured: Captured = {};
    await handleCreateInvoice(makeClient(captured), { ...BASE, doc_number: "4321", draft: false });
    expect(findInvoicesByDocNumber).toHaveBeenCalledWith(expect.anything(), "4321");
    expect(captured.obj!.DocNumber).toBe("4321");
  });

  it("HARD-REFUSES a real create when the number already exists, and writes NOTHING", async () => {
    findInvoicesByDocNumber.mockResolvedValue([match({ Id: "56265", DocNumber: "4319" })]);
    const captured: Captured = {};
    await expect(
      handleCreateInvoice(makeClient(captured), { ...BASE, doc_number: "4319", draft: false })
    ).rejects.toThrow(/already in use|duplicate/i);
    expect(captured.obj).toBeUndefined(); // never wrote
  });

  it("names the colliding invoice(s) in the refusal so the caller can act", async () => {
    findInvoicesByDocNumber.mockResolvedValue([
      match({ Id: "56265", DocNumber: "4319" }),
      match({ Id: "56278", DocNumber: "4319", name: "Arthritis Foundation" }),
    ]);
    await expect(
      handleCreateInvoice(makeClient({}), { ...BASE, doc_number: "4319", draft: false })
    ).rejects.toThrow(/56265.*56278|56278.*56265/s);
  });

  it("draft=true WARNS about the duplicate in the preview but writes NOTHING", async () => {
    findInvoicesByDocNumber.mockResolvedValue([match({ Id: "56265", DocNumber: "4319" })]);
    const captured: Captured = {};
    const res = await handleCreateInvoice(makeClient(captured), {
      ...BASE,
      doc_number: "4319",
      draft: true,
    });
    const text = res.content[0].text;
    expect(text).toMatch(/DRAFT - Invoice Preview/);
    expect(text).toMatch(/DUPLICATE NUMBER/);
    expect(text).toMatch(/4319/);
    expect(captured.obj).toBeUndefined();
  });

  it("draft defaults to true (no explicit draft) and does not write", async () => {
    const captured: Captured = {};
    const res = await handleCreateInvoice(makeClient(captured), { ...BASE, doc_number: "4321" });
    expect(res.content[0].text).toMatch(/DRAFT/);
    expect(captured.obj).toBeUndefined();
  });
});
