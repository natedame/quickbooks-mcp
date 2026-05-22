#!/usr/bin/env node
// QuickBooks MCP Server - Entry Point
// Load .env file from the package directory (workaround for Claude Code env var bug)
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";
import { setOutputMode } from "./utils/output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Look for .env in the package root (one level up from dist/)
config({ path: join(__dirname, "..", ".env"), quiet: true });

if (process.env.QBO_INLINE_OUTPUT === "true") {
  setOutputMode("http");
}

// Capture intuit_tid from QBO API response headers for troubleshooting.
// node-quickbooks uses CJS require('axios'), which is a different instance from ESM import.
// We must hook into the CJS axios to intercept node-quickbooks HTTP calls.
const require = createRequire(import.meta.url);
const cjsAxios = require("axios");
cjsAxios.interceptors.response.use(
  (response: { headers?: Record<string, string>; config: { method?: string; url?: string } }) => {
    const tid = response.headers?.["intuit_tid"];
    if (tid) {
      console.error(`[QBO] intuit_tid=${tid} ${response.config.method?.toUpperCase()} ${response.config.url}`);
    }
    return response;
  },
  (error: { response?: { headers?: Record<string, string>; status?: number }; config?: { method?: string; url?: string } }) => {
    const tid = error.response?.headers?.["intuit_tid"];
    if (tid) {
      console.error(`[QBO] intuit_tid=${tid} ${error.response?.status} ${error.config?.method?.toUpperCase()} ${error.config?.url}`);
    }
    return Promise.reject(error);
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("QuickBooks MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
