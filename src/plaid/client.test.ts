// Unit tests for PlaidClient link-token creation. The safety-critical property
// for the EMBEDDED connect path (scripts/plaid-embed-connect.mjs) is that
// createLinkToken builds a PLAIN link_token WITHOUT the `hosted_link` field —
// its presence is exactly what makes Plaid host the flow (the flow that died
// silently on production for us). These tests pin that contract, and confirm the
// hosted variant still sets hosted_link, so the two paths can't drift.

import { describe, it, expect, vi } from "vitest";
import { PlaidClient } from "./client.js";
import type { PlaidApi } from "plaid";

function fakeApi(overrides: Partial<Record<keyof PlaidApi, unknown>> = {}): {
  api: PlaidApi;
  calls: { linkTokenCreate: unknown[] };
} {
  const calls = { linkTokenCreate: [] as unknown[] };
  const api = {
    linkTokenCreate: vi.fn(async (req: unknown) => {
      calls.linkTokenCreate.push(req);
      return { data: { link_token: "link-production-abc", expiration: "2026-07-16T00:00:00Z", hosted_link_url: "https://secure.plaid.com/hl/x" } };
    }),
    ...overrides,
  } as unknown as PlaidApi;
  return { api, calls };
}

describe("PlaidClient.createLinkToken (embedded Link)", () => {
  it("does NOT set hosted_link — the field that makes Plaid host the (broken) flow", async () => {
    const { api, calls } = fakeApi();
    const client = new PlaidClient(api, "production");
    const out = await client.createLinkToken("user-1");

    expect(calls.linkTokenCreate).toHaveLength(1);
    const req = calls.linkTokenCreate[0] as Record<string, unknown>;
    expect(req).not.toHaveProperty("hosted_link");
    expect(out.link_token).toBe("link-production-abc");
    expect(out).not.toHaveProperty("hosted_link_url");
  });

  it("requests the Transactions product for the US, non-OAuth (no redirect_uri)", async () => {
    const { api, calls } = fakeApi();
    const client = new PlaidClient(api, "production");
    await client.createLinkToken("profound-strategy-associated-bank");

    const req = calls.linkTokenCreate[0] as Record<string, unknown>;
    expect(req.products).toEqual(["transactions"]);
    expect(req.country_codes).toEqual(["US"]);
    expect((req.user as Record<string, unknown>).client_user_id).toBe("profound-strategy-associated-bank");
    // redirect_uri is only for OAuth institutions — must not be set speculatively.
    expect(req).not.toHaveProperty("redirect_uri");
  });

  it("createHostedLink STILL sets hosted_link — the two paths stay distinct", async () => {
    const { api, calls } = fakeApi();
    const client = new PlaidClient(api, "production");
    await client.createHostedLink("user-1", { urlLifetimeSeconds: 86400 });

    const req = calls.linkTokenCreate[0] as Record<string, unknown>;
    expect(req).toHaveProperty("hosted_link");
    expect((req.hosted_link as Record<string, unknown>).url_lifetime_seconds).toBe(86400);
  });
});
