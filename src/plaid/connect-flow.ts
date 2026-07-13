// Pure decision logic for the one-time production bank connect.
//
// These functions have no I/O so the connect runner's branching (generate a
// fresh link, resume an in-flight one, regenerate an expired one, or refuse
// because the bank is already connected) and its parse of a Hosted Link session
// are unit-testable without touching Plaid or the filesystem.

import type { PlaidItem, PendingLink } from "./token-store.js";

/** What the connect runner should do, decided from durable state + the clock. */
export type ConnectAction =
  | "already_connected" // an Item exists for this env — refuse, never mint a 2nd link
  | "generate" // no pending link — create a fresh Hosted Link
  | "regenerate" // pending link exists but its URL lifetime has passed — replace it
  | "resume"; // pending link still valid — keep polling it

/**
 * Decide the connect action from the durable state and the current time.
 *
 * Order matters: an already-connected bank short-circuits everything (idempotency
 * guard — re-running after a successful capture must NEVER mint a second link and
 * risk a duplicate bank Item / an overwritten access_token). Only then do we look
 * at the pending link and whether its URL has expired.
 */
export function decideConnectAction(
  existingItem: PlaidItem | null,
  pendingLink: PendingLink | null,
  nowMs: number
): ConnectAction {
  if (existingItem) return "already_connected";
  if (!pendingLink) return "generate";
  const expMs = pendingLink.expiration ? Date.parse(pendingLink.expiration) : NaN;
  if (Number.isFinite(expMs) && nowMs > expMs) return "regenerate";
  return "resume";
}

/** The subset of a Hosted Link session `/link/token/get` returns that we read. */
export interface LinkSession {
  link_session_id?: string;
  finished_at?: string | null;
  results?: {
    item_add_results?: Array<{
      public_token?: string;
      institution?: { name?: string; institution_id?: string } | null;
    }>;
  } | null;
  // Deprecated legacy shape — some older integrations still receive this.
  on_success?: {
    metadata?: { institution?: { name?: string; institution_id?: string } | null };
    // legacy public_token lived at the session level in on_success flows
  } | null;
  exit?: unknown | null;
}

/** The outcome of scanning a link_token's sessions for a completed connect. */
export interface CapturedSession {
  /** true once ANY session has finished (finished_at set). */
  finished: boolean;
  /** present iff a finished session carried a successful Item add. */
  publicToken?: string;
  institutionId?: string;
  institutionName?: string;
  /** true iff the latest finished session ended without an Item add (user exited/abandoned). */
  exited?: boolean;
}

function finishedTime(s: LinkSession): number {
  return s.finished_at ? Date.parse(s.finished_at) : NaN;
}

/**
 * Pick the meaningful outcome from a link_token's sessions.
 *
 * A single link_token can have MULTIPLE sessions (retries after an exit), and the
 * array order is not guaranteed — so we pick the MOST RECENTLY finished session
 * that carries a public_token. If none succeeded but some finished, the user
 * exited. If none finished, the connect is still in progress.
 */
export function selectCapturedSession(sessions: LinkSession[]): CapturedSession {
  const finished = sessions.filter((s) => s.finished_at != null);
  if (finished.length === 0) return { finished: false };

  // Most-recent-first so a later successful retry wins over an earlier exit.
  const byRecency = [...finished].sort((a, b) => (finishedTime(b) || 0) - (finishedTime(a) || 0));

  for (const s of byRecency) {
    const add = s.results?.item_add_results?.find((r) => r.public_token);
    if (add?.public_token) {
      return {
        finished: true,
        publicToken: add.public_token,
        institutionId: add.institution?.institution_id,
        institutionName: add.institution?.name,
      };
    }
  }
  // Something finished, but nothing carried a public_token → the user exited.
  return { finished: true, exited: true };
}
