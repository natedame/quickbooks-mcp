// Unit tests for the pending-Hosted-Link persistence used to resume a connect
// across separate runs of the connect runner. Verifies the save/load/clear
// round-trip and per-env isolation, against a temp store dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { savePendingLink, loadPendingLink, clearPendingLink, type PendingLink } from "./token-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qbo-pending-"));
  // token-store's baseDir() uses dirname(QBO_CREDENTIAL_FILE) when set.
  process.env.QBO_CREDENTIAL_FILE = join(dir, "credentials.json");
});

afterEach(() => {
  delete process.env.QBO_CREDENTIAL_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function pending(env: "sandbox" | "production", token: string): PendingLink {
  return {
    env,
    link_token: token,
    expiration: "2026-07-14T18:00:00Z",
    hosted_link_url: `https://secure.plaid.com/link/${token}`,
    created_at: "2026-07-13T17:00:00Z",
  };
}

describe("pending link store", () => {
  it("returns null when no pending link exists", async () => {
    expect(await loadPendingLink("production")).toBeNull();
  });

  it("round-trips a saved pending link", async () => {
    const pl = pending("production", "link-abc");
    await savePendingLink(pl);
    expect(await loadPendingLink("production")).toEqual(pl);
  });

  it("writes the pending file at 0600 (contains a link_token)", async () => {
    await savePendingLink(pending("production", "link-secret"));
    const mode = statSync(join(dir, "plaid-pending-link.production.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("isolates sandbox and production pending links", async () => {
    await savePendingLink(pending("sandbox", "link-sbx"));
    await savePendingLink(pending("production", "link-prod"));
    expect((await loadPendingLink("sandbox"))?.link_token).toBe("link-sbx");
    expect((await loadPendingLink("production"))?.link_token).toBe("link-prod");
  });

  it("clears a pending link and is a no-op when already absent", async () => {
    await savePendingLink(pending("production", "link-x"));
    await clearPendingLink("production");
    expect(await loadPendingLink("production")).toBeNull();
    await expect(clearPendingLink("production")).resolves.toBeUndefined(); // no throw when absent
  });
});
