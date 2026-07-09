// Shadow mode: pull posted transactions, categorize them, and produce a preview
// of exactly what the pipeline WOULD book — writing nothing to QuickBooks and
// nothing to the dedup ledger. This both proves correctness before any cutover
// and delivers the bank-feed visibility the original ticket wanted, at zero risk.

import type { PlaidEnv } from "./config.js";
import type { PlaidClient, PlaidTransaction, AccountBalance } from "./client.js";
import { categorize, type BookingProposal, type BookingKind, type CategorizationRules } from "./categorize.js";
import { isBooked, type DedupLedger } from "./dedup-store.js";

export interface ShadowSummary {
  env: PlaidEnv;
  added: number;
  posted: number;
  pending: number;
  alreadyBooked: number;
  proposals: BookingProposal[];
  byKind: Record<BookingKind, number>;
  uncertain: BookingProposal[];
  totalOutCents: number;
  totalInCents: number;
  balances: AccountBalance[];
  nextCursor: string;
}

const ALL_KINDS: BookingKind[] = [
  "money_out",
  "money_in",
  "transfer",
  "cc_payment",
  "refund",
  "ar_settlement",
  "uncertain",
];

/**
 * Run one shadow pass over the item's transactions.
 *
 * Pure preview: reads Plaid + the dedup ledger, writes NOTHING (no QBO writes,
 * no ledger writes, no cursor persistence). The caller decides what to persist.
 * Books nothing pending (pending items get a new id when they post).
 */
export async function runShadow(opts: {
  env: PlaidEnv;
  client: PlaidClient;
  accessToken: string;
  cursor?: string;
  rules: CategorizationRules;
  ledger: DedupLedger;
}): Promise<ShadowSummary> {
  const { env, client, accessToken, rules, ledger } = opts;

  const added: PlaidTransaction[] = [];
  let balances: AccountBalance[] = [];
  let cursor = opts.cursor;
  let hasMore = true;
  while (hasMore) {
    const page = await client.syncTransactions(accessToken, cursor);
    added.push(...page.added);
    if (page.accounts) balances = page.accounts;
    cursor = page.next_cursor;
    hasMore = page.has_more;
  }

  const posted = added.filter((t) => !t.pending);
  const pending = added.length - posted.length;

  const byKind: Record<BookingKind, number> = Object.fromEntries(
    ALL_KINDS.map((k) => [k, 0])
  ) as Record<BookingKind, number>;

  const proposals: BookingProposal[] = [];
  let alreadyBooked = 0;
  let totalOutCents = 0;
  let totalInCents = 0;

  for (const t of posted) {
    if (isBooked(ledger, t.transaction_id)) {
      alreadyBooked++;
      continue;
    }
    const p = categorize(t, rules);
    proposals.push(p);
    byKind[p.kind]++;
    if (p.direction === "out") totalOutCents += p.amount_cents;
    else totalInCents += p.amount_cents;
  }

  return {
    env,
    added: added.length,
    posted: posted.length,
    pending,
    alreadyBooked,
    proposals,
    byKind,
    uncertain: proposals.filter((p) => p.kind === "uncertain"),
    totalOutCents,
    totalInCents,
    balances,
    nextCursor: cursor || "",
  };
}

/** Render a shadow summary as human-readable preview text (for the ticket / logs). */
export function formatShadowSummary(s: ShadowSummary): string {
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const lines: string[] = [
    `SHADOW RUN (${s.env}) — preview only, nothing was booked`,
    "",
    `Transactions pulled: ${s.added} (${s.posted} posted, ${s.pending} pending)`,
    `Already booked (skipped): ${s.alreadyBooked}`,
    `New to book: ${s.proposals.length}`,
    "",
    "Would book by type:",
    ...ALL_KINDS.filter((k) => s.byKind[k] > 0).map((k) => `  ${k}: ${s.byKind[k]}`),
    "",
    `Total money out: ${dollars(s.totalOutCents)}   Total money in: ${dollars(s.totalInCents)}`,
  ];
  if (s.uncertain.length > 0) {
    lines.push("", `Needs a human (${s.uncertain.length} uncertain):`);
    for (const u of s.uncertain.slice(0, 25)) {
      lines.push(`  ${u.date}  ${dollars(u.amount_cents)}  ${u.name}  — ${u.reason}`);
    }
    if (s.uncertain.length > 25) lines.push(`  ...and ${s.uncertain.length - 25} more`);
  }
  return lines.join("\n");
}
