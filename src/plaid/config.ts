// Plaid configuration + client factory.
//
// Reads Plaid API credentials from ~/.secrets/plaid.env (the secure store Nate
// populates from the Plaid dashboard), mirroring how the QuickBooks
// LocalCredentialProvider reads ~/.quickbooks-mcp/credentials.json. Environment
// variables take precedence over the file for every field, so the launchd
// plist or a test harness can override without editing the secrets file.
//
// The active environment (sandbox vs production) is chosen by PLAID_ENV and
// defaults to "sandbox" — production is only selected explicitly, so nothing
// can accidentally hit the real bank / billable environment.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export type PlaidEnv = "sandbox" | "production";

const DEFAULT_SECRETS_PATH = join(homedir(), ".secrets", "plaid.env");

/** Parse a KEY=VALUE .env file into a plain object. Ignores blanks and # comments. */
function parseEnvFile(path: string): Record<string, string> {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export interface PlaidConfig {
  env: PlaidEnv;
  clientId: string;
  secret: string;
}

/**
 * Resolve the active Plaid configuration.
 *
 * Precedence for every field: process.env first, then the ~/.secrets/plaid.env
 * file. The secret is selected by environment: sandbox -> PLAID_SECRET_SANDBOX,
 * production -> PLAID_SECRET_PRODUCTION.
 *
 * @throws if the client id or the selected environment's secret is missing.
 */
export function getPlaidConfig(): PlaidConfig {
  const file = parseEnvFile(process.env.PLAID_SECRETS_FILE || DEFAULT_SECRETS_PATH);

  const env: PlaidEnv =
    (process.env.PLAID_ENV || file.PLAID_ENV || "sandbox").toLowerCase() === "production"
      ? "production"
      : "sandbox";

  const clientId = process.env.PLAID_CLIENT_ID || file.PLAID_CLIENT_ID || "";
  const secret =
    env === "production"
      ? process.env.PLAID_SECRET_PRODUCTION || file.PLAID_SECRET_PRODUCTION || ""
      : process.env.PLAID_SECRET_SANDBOX || file.PLAID_SECRET_SANDBOX || "";

  if (!clientId) {
    throw new Error(
      `Plaid client_id not found (checked env + ${DEFAULT_SECRETS_PATH}). ` +
        "Set PLAID_CLIENT_ID in ~/.secrets/plaid.env."
    );
  }
  if (!secret) {
    throw new Error(
      `Plaid ${env} secret not found (checked env + ${DEFAULT_SECRETS_PATH}). ` +
        `Set PLAID_SECRET_${env.toUpperCase()} in ~/.secrets/plaid.env.`
    );
  }

  return { env, clientId, secret };
}

/** Build a PlaidApi client for the active (default sandbox) environment. */
export function getPlaidClient(config: PlaidConfig = getPlaidConfig()): PlaidApi {
  const configuration = new Configuration({
    basePath: PlaidEnvironments[config.env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": config.clientId,
        "PLAID-SECRET": config.secret,
      },
    },
  });
  return new PlaidApi(configuration);
}
