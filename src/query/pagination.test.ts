// Unit tests for the throttle handling added in GEN-7941. Widening
// query_account_transactions from 7 to 12 entity types took the parallel fan-out
// past what QuickBooks accepts per realm, and live runs came back with 429s on ten
// of the twelve queries. These lock the two guards: a capped fan-out, and a retry
// at the single point every query passes through.

import { describe, it, expect, vi } from "vitest";
import { mapWithConcurrency, paginatedQuery } from "./pagination.js";
import { PaginationParams } from "../types/index.js";

const params: PaginationParams = { maxResults: 10000, startPosition: null, baseCriteria: "WHERE TxnDate >= '2026-01-01'" };

// Fake client whose finder replays a scripted sequence of failures then succeeds.
function makeClient(script: Array<Error | null>, seen: { calls: number } = { calls: 0 }) {
  return {
    findBills: (_criteria: string, cb: (err: Error | null, result: unknown) => void) => {
      const step = script[seen.calls] ?? null;
      seen.calls++;
      // Async so the retry delay is genuinely exercised.
      setTimeout(() => step ? cb(step, null) : cb(null, { QueryResponse: { Bill: [{ Id: "1" }] } }), 0);
    },
  } as unknown as import("node-quickbooks");
}

function throttled(): Error {
  return new Error("Request failed with status code 429");
}

describe("throttle retry", () => {
  it("recovers from a 429 instead of surfacing it as an error", async () => {
    const seen = { calls: 0 };
    const res = await paginatedQuery(makeClient([throttled(), throttled()], seen), "findBills", params);
    expect(res.entities).toHaveLength(1);
    expect(seen.calls).toBe(3); // two rejections, then the successful call
  });

  it("recognises a 429 carried on the response object rather than the message", async () => {
    const err = Object.assign(new Error("Request failed"), { response: { status: 429 } });
    const res = await paginatedQuery(makeClient([err]), "findBills", params);
    expect(res.entities).toHaveLength(1);
  });

  it("gives up rather than retrying forever", async () => {
    // Virtual time, so the real backoff ladder (~6-12s) is exercised without
    // waiting it out.
    vi.useFakeTimers();
    try {
      const seen = { calls: 0 };
      const pending = paginatedQuery(makeClient(Array.from({ length: 20 }, throttled), seen), "findBills", params);
      const settled = expect(pending).rejects.toThrow(/429/);
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      expect(seen.calls).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an error that is not a throttle", async () => {
    const seen = { calls: 0 };
    await expect(
      paginatedQuery(makeClient([new Error("Unauthorized")], seen), "findBills", params)
    ).rejects.toThrow("Unauthorized");
    expect(seen.calls).toBe(1);
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // still genuinely parallel
  });

  it("returns results in input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 10, 20, 0], 4, async (ms, i) => {
      await new Promise(r => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("handles an empty list and a cap larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 99, async n => n * 2)).toEqual([2, 4]);
  });
});
