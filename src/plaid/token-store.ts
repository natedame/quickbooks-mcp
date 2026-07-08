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

function getItemPath(env: PlaidEnv): string {
  const base =
    process.env.QBO_CREDENTIAL_FILE
      ? dirname(process.env.QBO_CREDENTIAL_FILE)
      : join(homedir(), ".quickbooks-mcp");
  return join(base, `plaid-item.${env}.json`);
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
