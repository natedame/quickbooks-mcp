// Unit tests for Plaid config resolution — focused on the safety-critical
// guarantee that production is only ever selected explicitly, and that the
// correct per-environment secret is chosen.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPlaidConfig } from "./config.js";

const ENV_KEYS = [
  "PLAID_ENV",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET_SANDBOX",
  "PLAID_SECRET_PRODUCTION",
  "PLAID_SECRETS_FILE",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function writeSecretsFile(dir: string, body: string): string {
  const p = join(dir, "plaid.env");
  writeFileSync(p, body);
  return p;
}

describe("getPlaidConfig", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    clearEnv();
    dir = mkdtempSync(join(tmpdir(), "plaid-cfg-"));
  });

  afterEach(() => {
    clearEnv();
    for (const k of ENV_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to sandbox and reads the sandbox secret from the file", () => {
    process.env.PLAID_SECRETS_FILE = writeSecretsFile(
      dir,
      "PLAID_CLIENT_ID=cid123\nPLAID_SECRET_SANDBOX=sbx_secret\nPLAID_SECRET_PRODUCTION=prod_secret\n"
    );
    const cfg = getPlaidConfig();
    expect(cfg.env).toBe("sandbox");
    expect(cfg.secret).toBe("sbx_secret");
    expect(cfg.clientId).toBe("cid123");
  });

  it("selects the production secret ONLY when PLAID_ENV=production is explicit", () => {
    process.env.PLAID_SECRETS_FILE = writeSecretsFile(
      dir,
      "PLAID_CLIENT_ID=cid123\nPLAID_SECRET_SANDBOX=sbx_secret\nPLAID_SECRET_PRODUCTION=prod_secret\n"
    );
    process.env.PLAID_ENV = "production";
    const cfg = getPlaidConfig();
    expect(cfg.env).toBe("production");
    expect(cfg.secret).toBe("prod_secret");
  });

  it("treats any non-'production' PLAID_ENV as sandbox (fail safe)", () => {
    process.env.PLAID_SECRETS_FILE = writeSecretsFile(
      dir,
      "PLAID_CLIENT_ID=cid123\nPLAID_SECRET_SANDBOX=sbx_secret\n"
    );
    for (const val of ["", "prod", "PRODUCTIONX", "sandbox", "garbage"]) {
      process.env.PLAID_ENV = val;
      expect(getPlaidConfig().env).toBe("sandbox");
    }
  });

  it("lets process.env override the file for each field", () => {
    process.env.PLAID_SECRETS_FILE = writeSecretsFile(
      dir,
      "PLAID_CLIENT_ID=file_cid\nPLAID_SECRET_SANDBOX=file_sbx\n"
    );
    process.env.PLAID_CLIENT_ID = "env_cid";
    process.env.PLAID_SECRET_SANDBOX = "env_sbx";
    const cfg = getPlaidConfig();
    expect(cfg.clientId).toBe("env_cid");
    expect(cfg.secret).toBe("env_sbx");
  });

  it("throws a clear error when the client_id is missing", () => {
    process.env.PLAID_SECRETS_FILE = writeSecretsFile(dir, "PLAID_SECRET_SANDBOX=sbx\n");
    expect(() => getPlaidConfig()).toThrow(/client_id not found/);
  });

  it("throws when the selected environment's secret is missing (production w/o prod secret)", () => {
    process.env.PLAID_SECRETS_FILE = writeSecretsFile(
      dir,
      "PLAID_CLIENT_ID=cid123\nPLAID_SECRET_SANDBOX=sbx_secret\n"
    );
    process.env.PLAID_ENV = "production";
    expect(() => getPlaidConfig()).toThrow(/production secret not found/);
  });

  it("ignores blank lines and # comments in the secrets file", () => {
    process.env.PLAID_SECRETS_FILE = writeSecretsFile(
      dir,
      "# Plaid creds\n\nPLAID_CLIENT_ID=cid123\n\n# secret below\nPLAID_SECRET_SANDBOX=sbx_secret\n"
    );
    expect(getPlaidConfig().clientId).toBe("cid123");
  });
});
