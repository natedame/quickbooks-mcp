// Unit tests for the connect-flow decision + session-parse logic. These are the
// safety-critical branches of the one-time production bank connect: the
// idempotency guard (never mint a 2nd link over a live connection), stale-link
// regeneration, and correctly reading a Hosted Link session's outcome.

import { describe, it, expect } from "vitest";
import { decideConnectAction, selectCapturedSession, type LinkSession } from "./connect-flow.js";
import type { PlaidItem, PendingLink } from "./token-store.js";

const NOW = Date.parse("2026-07-13T18:00:00Z");

function item(): PlaidItem {
  return {
    env: "production",
    access_token: "access-x",
    item_id: "item-x",
    created_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  };
}
function pending(expiration: string): PendingLink {
  return {
    env: "production",
    link_token: "link-x",
    expiration,
    hosted_link_url: "https://secure.plaid.com/link/x",
    created_at: "2026-07-13T17:00:00Z",
  };
}

describe("decideConnectAction", () => {
  it("refuses when an Item already exists (idempotency guard — never a 2nd link)", () => {
    expect(decideConnectAction(item(), null, NOW)).toBe("already_connected");
    // Even with a pending link present, an existing Item wins.
    expect(decideConnectAction(item(), pending("2026-07-14T18:00:00Z"), NOW)).toBe("already_connected");
  });

  it("generates a fresh link when nothing is connected or pending", () => {
    expect(decideConnectAction(null, null, NOW)).toBe("generate");
  });

  it("resumes a still-valid pending link", () => {
    expect(decideConnectAction(null, pending("2026-07-14T18:00:00Z"), NOW)).toBe("resume");
  });

  it("regenerates when the pending link's URL lifetime has passed", () => {
    expect(decideConnectAction(null, pending("2026-07-13T17:30:00Z"), NOW)).toBe("regenerate");
  });

  it("resumes (not regenerate) when the expiration is unparseable rather than clearly past", () => {
    expect(decideConnectAction(null, pending("not-a-date"), NOW)).toBe("resume");
  });
});

describe("selectCapturedSession", () => {
  const finishedSuccess = (finishedAt: string, token: string, instName?: string): LinkSession => ({
    link_session_id: `s-${token}`,
    finished_at: finishedAt,
    results: {
      item_add_results: [
        { public_token: token, institution: { name: instName, institution_id: "ins_1" } },
      ],
    },
  });
  const finishedExit = (finishedAt: string): LinkSession => ({
    link_session_id: "s-exit",
    finished_at: finishedAt,
    results: { item_add_results: [] },
    exit: { error: null },
  });
  const inProgress = (): LinkSession => ({ link_session_id: "s-live", finished_at: null });

  it("returns not-finished while the connect is still in progress", () => {
    expect(selectCapturedSession([inProgress()])).toEqual({ finished: false });
    expect(selectCapturedSession([])).toEqual({ finished: false });
  });

  it("captures the public_token + institution from a finished successful session", () => {
    const got = selectCapturedSession([finishedSuccess("2026-07-13T17:50:00Z", "public-abc", "Associated Bank")]);
    expect(got).toMatchObject({
      finished: true,
      publicToken: "public-abc",
      institutionId: "ins_1",
      institutionName: "Associated Bank",
    });
    expect(got.exited).toBeFalsy();
  });

  it("flags exited when a session finished with no Item add", () => {
    expect(selectCapturedSession([finishedExit("2026-07-13T17:40:00Z")])).toEqual({ finished: true, exited: true });
  });

  it("picks the MOST-RECENT finished success across multiple sessions (retry after exit)", () => {
    const sessions = [
      finishedExit("2026-07-13T17:30:00Z"),
      finishedSuccess("2026-07-13T17:55:00Z", "public-latest"),
      finishedSuccess("2026-07-13T17:45:00Z", "public-earlier"),
    ];
    expect(selectCapturedSession(sessions).publicToken).toBe("public-latest");
  });

  it("prefers a successful session even when an exit finished later (a real connect is the goal)", () => {
    // A later exit does not erase an earlier success: we still want the captured token.
    const sessions = [finishedSuccess("2026-07-13T17:45:00Z", "public-good"), finishedExit("2026-07-13T17:55:00Z")];
    expect(selectCapturedSession(sessions).publicToken).toBe("public-good");
  });
});
