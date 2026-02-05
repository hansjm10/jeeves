#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getPrunerConfig } from "./pruner.js";
import { handleBash } from "./tools/bash.js";
import { handleGrep } from "./tools/grep.js";
import { readInputSchema, handleRead } from "./tools/read.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a JSON-RPC-compatible error with an exact `message` string.
 *
 * Unlike `McpError`, which prefixes messages with `"MCP error <code>: "`,
 * this produces a plain `Error` whose `.message` is the literal string
 * supplied, ensuring the wire-format `error.message` matches exactly.
 */
function jsonRpcError(code: number, message: string): Error {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-pruner",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool input schemas (Zod raw shapes for registration via server.tool)
// ---------------------------------------------------------------------------

const bashInputShape = {
  command: z.string().describe("Shell command to run"),
  context_focus_question: z
    .string()
    .optional()
    .describe("Optional question to focus the pruned output on"),
};

const grepInputShape = {
  pattern: z.string().describe("Pattern to search for (regex)"),
  path: z
    .string()
    .optional()
    .describe("File/dir path to search (defaults to '.')"),
  context_focus_question: z
    .string()
    .optional()
    .describe("Optional question to focus the pruned output on"),
};

// Register tools so tools/list exposes correct schemas.
// The callbacks registered here are placeholders; actual dispatch is handled
// by the overridden CallToolRequestSchema handler below.
server.tool(
  "read",
  "Read file contents with optional context-focused pruning",
  readInputSchema,
  async () => ({ content: [{ type: "text" as const, text: "" }] }),
);

server.tool(
  "bash",
  "Execute a shell command with optional context-focused pruning",
  bashInputShape,
  async () => ({ content: [{ type: "text" as const, text: "" }] }),
);

server.tool(
  "grep",
  "Search files with grep and optional context-focused pruning",
  grepInputShape,
  async () => ({ content: [{ type: "text" as const, text: "" }] }),
);

// ---------------------------------------------------------------------------
// Compiled Zod schemas for validation in the custom handler
// ---------------------------------------------------------------------------

const readSchema = z.object(readInputSchema);
const bashSchema = z.object(bashInputShape);
const grepSchema = z.object(grepInputShape);

// ---------------------------------------------------------------------------
// Override the CallToolRequestSchema handler installed by server.tool() so
// that:
//   1. Validation failures produce JSON-RPC error code -32602 with the exact
//      message "Invalid params" (the SDK default includes tool name + details).
//   2. Tool results never set isError (the SDK default catch wraps errors with
//      isError: true).
// ---------------------------------------------------------------------------

server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const rawArgs = request.params.arguments ?? {};

  const cwd = process.env.MCP_PRUNER_CWD || process.cwd();
  const prunerConfig = getPrunerConfig();

  switch (toolName) {
    case "read": {
      const parsed = readSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw jsonRpcError(ErrorCode.InvalidParams, "Invalid params");
      }
      return handleRead(parsed.data, { cwd, prunerConfig });
    }

    case "bash": {
      const parsed = bashSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw jsonRpcError(ErrorCode.InvalidParams, "Invalid params");
      }
      return handleBash(parsed.data, cwd, prunerConfig);
    }

    case "grep": {
      const parsed = grepSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw jsonRpcError(ErrorCode.InvalidParams, "Invalid params");
      }
      return handleGrep(parsed.data);
    }

    default:
      throw jsonRpcError(
        ErrorCode.InvalidParams,
        `Tool ${toolName} not found`,
      );
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-pruner] Server started on stdio\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`[mcp-pruner] Fatal error: ${String(error)}\n`);
  process.exit(1);
});
