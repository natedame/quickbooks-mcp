#!/usr/bin/env node
// Usage: node complete-oauth.mjs <authorization_code> <realm_id>
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exchangeCodeForTokens } from './dist/credentials/oauth-client.js';
import { LocalCredentialProvider } from './dist/credentials/local-provider.js';

const [,, code, realmId] = process.argv;
if (!code || !realmId) {
  console.error('Usage: node complete-oauth.mjs <authorization_code> <realm_id>');
  process.exit(1);
}

// Read client credentials from credentials.json (never hardcode)
const credsPath = join(homedir(), '.quickbooks-mcp', 'credentials.json');
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
if (!creds.client_id || !creds.client_secret) {
  console.error('Missing client_id or client_secret in', credsPath);
  process.exit(1);
}

try {
  const result = await exchangeCodeForTokens(
    creds.client_id,
    creds.client_secret,
    code,
    realmId
  );
  const provider = new LocalCredentialProvider();
  await provider.saveCredentials(result.credentials);
  console.log(`Authentication successful! Connected to company: ${result.companyId}`);
  console.log('Credentials saved to ~/.quickbooks-mcp/credentials.json');
} catch (e) {
  console.error('Authentication failed:', e.message);
  process.exit(1);
}
