// Unit tests for the shadow-run orchestration: it must page the cursor loop,
// skip already-booked transactions, ignore pending, and tally correctly — while
// writing nothing.

import { describe, it, expect } from "vitest";
import { runShadow } from "./shadow-run.js";
import { EMPTY_RULES, type CategorizationRules } from "./categorize.js";
import type { DedupLedger } from "./dedup-store.js";
import type { PlaidClient, PlaidTransaction, SyncPage } from "./client.js";

function tx(id: string, amount: number, pending = false, name = "Vendor"): PlaidTransaction {
  return { transaction_id: id, account_id: "a1", amount, date: "2026-07-08", name, pending };
}

// Minimal fake PlaidClient that returns scripted sync pages, then stops.
function fakeClient(pages: SyncPage[]): PlaidClient {
  let i = 0;
  return {
    async syncTransactions(): Promise<SyncPage> {
      return pages[i++];
    },
  } as unknown as PlaidClient;
}

const RULES: CategorizationRules = {
  vendorRules: [{ match: "PG&E", kind: "money_out", account: "Utilities" }],
};

describe("runShadow", () => {
  it("pages the cursor loop, filters pending, skips already-booked, tallies", async () => {
    const pages: SyncPage[] = [
      {
        added: [tx("p1", 100, false, "PG&E"), tx("pend", 50, true), tx("dup", 20)],
        modified: [],
        removed: [],
        next_cursor: "c1",
        has_more: true,
        accounts: [
          { account_id: "a1", name: "Checking", type: "depository", current: 500, available: 500 },
        ],
      },
      {
        added: [tx("p2", 75, false, "Unknown Vendor")],
        modified: [],
        removed: [],
        next_cursor: "c2",
        has_more: false,
      },
    ];
    const ledger: DedupLedger = { env: "sandbox", entries: { dup: { qbo_type: "Purchase", qbo_id: "1", booked_at: "x" } } };

    const s = await runShadow({
      env: "sandbox",
      client: fakeClient(pages),
      accessToken: "tok",
      rules: RULES,
      ledger,
    });

    expect(s.added).toBe(4); // p1, pend, dup, p2
    expect(s.posted).toBe(3); // pend excluded
    expect(s.pending).toBe(1);
    expect(s.alreadyBooked).toBe(1); // dup skipped
    expect(s.proposals).toHaveLength(2); // p1, p2
    expect(s.byKind.money_out).toBe(1); // PG&E
    expect(s.byKind.uncertain).toBe(1); // Unknown Vendor
    expect(s.totalOutCents).toBe(17500); // 100 + 75 in cents
    expect(s.nextCursor).toBe("c2");
    expect(s.balances).toHaveLength(1);
  });

  it("empty feed yields an empty, zeroed summary", async () => {
    const s = await runShadow({
      env: "sandbox",
      client: fakeClient([{ added: [], modified: [], removed: [], next_cursor: "c", has_more: false }]),
      accessToken: "tok",
      rules: EMPTY_RULES,
      ledger: { env: "sandbox", entries: {} },
    });
    expect(s.posted).toBe(0);
    expect(s.proposals).toHaveLength(0);
    expect(s.uncertain).toHaveLength(0);
  });
});
