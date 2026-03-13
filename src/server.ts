// MCP Server setup and handler registration

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, executeTool } from "./tools/index.js";

// Create MCP server
export const server = new Server(
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

// Filter out write/delete tools when QBO_READ_ONLY is enabled
const isReadOnly = process.env.QBO_READ_ONLY === "true";
const activeToolDefinitions = isReadOnly
  ? toolDefinitions.filter((t) => !t.name.match(/^(create_|edit_|delete_)/))
  : toolDefinitions;

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: activeToolDefinitions,
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (isReadOnly && /^(create_|edit_|delete_)/.test(name)) {
    return {
      content: [{ type: "text", text: `Tool "${name}" is disabled in read-only mode (QBO_READ_ONLY=true).` }],
      isError: true,
    };
  }
  return executeTool(name, args as Record<string, unknown>);
});
