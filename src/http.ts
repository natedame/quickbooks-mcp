#!/usr/bin/env node
// QuickBooks MCP Server - HTTP Entry Point
// Runs as an HTTP server instead of stdio for Claude Code compatibility.

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "./serverFactory.js";
import { setOutputMode } from "./utils/output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Look for .env in the package root (one level up from dist/)
config({ path: join(__dirname, "..", ".env"), quiet: true });

setOutputMode("http");

// Capture intuit_tid from QBO API response headers for troubleshooting.
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

const PORT = parseInt(process.env.QBO_MCP_PORT || process.env.PORT || "3013", 10);

// Track active sessions: sessionId -> transport
const sessions = new Map<string, StreamableHTTPServerTransport>();

async function main() {
  const httpServer = createServer(async (req, res) => {
    // Health check endpoint
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "quickbooks-mcp" }));
      return;
    }

    // MCP endpoint
    if (req.url === "/mcp") {
      // Check for existing session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session: create transport + server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
      }
      return;
    }

    // Fallback
    res.writeHead(404);
    res.end("Not Found");
  });

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.error(`QuickBooks MCP server running on http://127.0.0.1:${PORT}/mcp`);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
