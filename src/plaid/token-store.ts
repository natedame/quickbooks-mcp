// Durable store for the connected Plaid Item.
//
// After Nate connects the bank once via Hosted Link, Plaid returns a long-lived
// access_token. We persist it (plus the transactions/sync cursor so pulls
// resume where they left off) alongside the QuickBooks credentials in
// ~/.quickbooks-mcp/, at 0600 like the QBO credential file. The access token is
// per-environment, so sandbox and production items never collide.

import { promises as fs } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { PlaidEnv } from "./config.js";

export interface PlaidItem {
  env: PlaidEnv;
  access_token: string;
  item_id: string;
  institution_id?: string;
  institution_name?: string;
  /** transactions/sync cursor — resume point for the next incremental pull. */
  cursor?: string;
  created_at: string;
  updated_at: string;
}

/**
 * A Hosted Link session in flight: the link_token we generated and are polling,
 * plus its URL expiration so a resume run can tell a still-valid link from a dead
 * one. Persisted so a capture can resume across separate invocations of the
 * connect runner (the user connects asynchronously).
 */
export interface PendingLink {
  env: PlaidEnv;
  link_token: string;
  /** ISO 8601 URL-lifetime expiration returned by link/token/create. */
  expiration: string;
  hosted_link_url: string;
  created_at: string;
}

function baseDir(): string {
  return process.env.QBO_CREDENTIAL_FILE
    ? dirname(process.env.QBO_CREDENTIAL_FILE)
    : join(homedir(), ".quickbooks-mcp");
}

function getItemPath(env: PlaidEnv): string {
  return join(baseDir(), `plaid-item.${env}.json`);
}

function getPendingPath(env: PlaidEnv): string {
  return join(baseDir(), `plaid-pending-link.${env}.json`);
}

/** Load the stored Item for an environment, or null if the bank isn't connected yet. */
export async function loadItem(env: PlaidEnv): Promise<PlaidItem | null> {
  try {
    const content = await fs.readFile(getItemPath(env), "utf-8");
    return JSON.parse(content) as PlaidItem;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Persist (create or overwrite) the Item for its environment at 0600. */
export async function saveItem(item: PlaidItem): Promise<void> {
  const path = getItemPath(item.env);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(item, null, 2), { mode: 0o600 });
}

/**
 * Update only the sync cursor for an environment's Item (called after each
 * successful transactions/sync page). No-op if no Item is stored.
 */
export async function saveCursor(env: PlaidEnv, cursor: string): Promise<void> {
  const item = await loadItem(env);
  if (!item) return;
  item.cursor = cursor;
  item.updated_at = new Date().toISOString();
  await saveItem(item);
}

/** Load the pending Hosted Link for an environment, or null if none is in flight. */
export async function loadPendingLink(env: PlaidEnv): Promise<PendingLink | null> {
  try {
    const content = await fs.readFile(getPendingPath(env), "utf-8");
    return JSON.parse(content) as PendingLink;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Persist (create or overwrite) the pending Hosted Link for its environment at 0600. */
export async function savePendingLink(pending: PendingLink): Promise<void> {
  const path = getPendingPath(pending.env);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(pending, null, 2), { mode: 0o600 });
}

/** Remove the pending Hosted Link for an environment (after capture, or when stale). No-op if absent. */
export async function clearPendingLink(env: PlaidEnv): Promise<void> {
  try {
    await fs.unlink(getPendingPath(env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
