// Unit tests for the invoice/sales-receipt DocNumber lookups (GEN-5749). Locks the
// behavior-preserving refactor of resolveInvoiceByDocNumber (money-critical: feeds
// create_payment) and the two new create-time duplicate-guard helpers. QuickBooks is a
// hand-rolled fake — no network.

import { describe, it, expect } from "vitest";
import {
  findInvoicesByDocNumber,
  resolveInvoiceByDocNumber,
  findSalesReceiptsByDocNumber,
} from "./cache.js";

function inv(id: string, docNumber: string) {
  return {
    Id: id,
    DocNumber: docNumber,
    CustomerRef: { value: "C1", name: "Arthritis Foundation" },
    Balance: 100,
    TotalAmt: 100,
  };
}

// Fake client: records the criteria string it was queried with, returns the seeded rows.
function makeClient(rows: unknown[], entityKey: "Invoice" | "SalesReceipt", captured: { criteria?: string } = {}) {
  const respond = (criteria: string, cb: (e: unknown, r: unknown) => void) => {
    captured.criteria = criteria;
    cb(null, { QueryResponse: { [entityKey]: rows } });
  };
  return {
    findInvoices: (criteria: string, cb: (e: unknown, r: unknown) => void) => respond(criteria, cb),
    findSalesReceipts: (criteria: string, cb: (e: unknown, r: unknown) => void) => respond(criteria, cb),
  } as unknown as import("node-quickbooks");
}

describe("findInvoicesByDocNumber", () => {
  it("returns [] when no invoice has the number (never throws)", async () => {
    const res = await findInvoicesByDocNumber(makeClient([], "Invoice"), "9999");
    expect(res).toEqual([]);
  });

  it("returns every match (so a duplicate guard can see >1)", async () => {
    const res = await findInvoicesByDocNumber(
      makeClient([inv("56265", "4319"), inv("56278", "4319")], "Invoice"),
      "4319"
    );
    expect(res.map((r) => r.Id)).toEqual(["56265", "56278"]);
  });

  it("escapes single quotes in the DocNumber criteria", async () => {
    const captured: { criteria?: string } = {};
    await findInvoicesByDocNumber(makeClient([], "Invoice", captured), "4'19");
    expect(captured.criteria).toContain("DocNumber = '4\\'19'");
  });
});

describe("resolveInvoiceByDocNumber (payment-path behavior preserved)", () => {
  it("throws when the invoice does not exist", async () => {
    await expect(
      resolveInvoiceByDocNumber(makeClient([], "Invoice"), "9999")
    ).rejects.toThrow(/not found/i);
  });

  it("throws when multiple invoices share the number (ambiguous)", async () => {
    await expect(
      resolveInvoiceByDocNumber(makeClient([inv("56265", "4319"), inv("56278", "4319")], "Invoice"), "4319")
    ).rejects.toThrow(/multiple/i);
  });

  it("returns the single match as an InvoiceSummary", async () => {
    const res = await resolveInvoiceByDocNumber(makeClient([inv("56211", "4315")], "Invoice"), "4315");
    expect(res).toMatchObject({ Id: "56211", DocNumber: "4315", Balance: 100, TotalAmt: 100 });
  });
});

describe("findSalesReceiptsByDocNumber", () => {
  it("returns [] when none exist", async () => {
    const res = await findSalesReceiptsByDocNumber(makeClient([], "SalesReceipt"), "5001");
    expect(res).toEqual([]);
  });

  it("returns a light {Id, DocNumber} shape for each match", async () => {
    const res = await findSalesReceiptsByDocNumber(
      makeClient([{ Id: "700", DocNumber: "SR-1" }], "SalesReceipt"),
      "SR-1"
    );
    expect(res).toEqual([{ Id: "700", DocNumber: "SR-1" }]);
  });
});
