// Dedup ledger: Plaid transaction_id -> the QuickBooks entry it was booked as.
//
// This is the single guard that makes re-running the pipeline safe: every booked
// Plaid transaction is recorded here, so a re-run (or an overlapping backfill)
// skips anything already booked instead of double-booking it. Stored per-env
// alongside the QBO credentials at 0600.
//
// Plaid guarantees a stable transaction_id for POSTED transactions, so it is a
// sound dedup key (pending items get a DIFFERENT id when they post, which is why
// the pipeline books pending=false only).

import { promises as fs } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { PlaidEnv } from "./config.js";

export interface BookedEntry {
  /** QBO entity type, e.g. "Purchase", "Deposit", "Payment". */
  qbo_type: string;
  /** QBO entity Id. Empty string in shadow mode (nothing was actually written). */
  qbo_id: string;
  booked_at: string;
  /** true when recorded by a shadow run (no real QBO write happened). */
  shadow?: boolean;
}

export interface DedupLedger {
  env: PlaidEnv;
  /** transaction_id -> booked entry */
  entries: Record<string, BookedEntry>;
}

function getPath(env: PlaidEnv): string {
  const base = process.env.QBO_CREDENTIAL_FILE
    ? dirname(process.env.QBO_CREDENTIAL_FILE)
    : join(homedir(), ".quickbooks-mcp");
  return join(base, `plaid-booked.${env}.json`);
}

export async function loadLedger(env: PlaidEnv): Promise<DedupLedger> {
  try {
    const content = await fs.readFile(getPath(env), "utf-8");
    return JSON.parse(content) as DedupLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { env, entries: {} };
    }
    throw error;
  }
}

async function saveLedger(ledger: DedupLedger): Promise<void> {
  const path = getPath(ledger.env);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

export function isBooked(ledger: DedupLedger, transactionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ledger.entries, transactionId);
}

/**
 * Record a booking and persist. Idempotent: if the transaction is already
 * recorded, the existing entry is kept (never overwritten) and false is
 * returned — this is what prevents a double-book on a re-run.
 * Returns true if it recorded a NEW entry.
 */
export async function recordBooking(
  env: PlaidEnv,
  transactionId: string,
  entry: BookedEntry
): Promise<boolean> {
  const ledger = await loadLedger(env);
  if (isBooked(ledger, transactionId)) return false;
  ledger.entries[transactionId] = entry;
  await saveLedger(ledger);
  return true;
}
