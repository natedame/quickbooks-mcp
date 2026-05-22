// MCP Server factory — creates a new Server instance per session (needed for HTTP transport)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, executeTool } from "./tools/index.js";

const isReadOnly = process.env.QBO_READ_ONLY === "true";
const writeWhitelist = process.env.QBO_WRITE_WHITELIST
  ? process.env.QBO_WRITE_WHITELIST.split(",").map((s) => s.trim())
  : [];

const activeToolDefinitions = isReadOnly
  ? toolDefinitions.filter((t) => {
      const isWriteTool = /^(create_|edit_|delete_)/.test(t.name);
      return !isWriteTool || writeWhitelist.includes(t.name);
    })
  : toolDefinitions;

export function createServer(): Server {
  const server = new Server(
    {
      name: "quickbooks-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: activeToolDefinitions,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (isReadOnly && /^(create_|edit_|delete_)/.test(name) && !writeWhitelist.includes(name)) {
      return {
        content: [{ type: "text", text: `Tool "${name}" is disabled in read-only mode (QBO_READ_ONLY=true).` }],
        isError: true,
      };
    }
    return executeTool(name, args as Record<string, unknown>);
  });

  return server;
}
