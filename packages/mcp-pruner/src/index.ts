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
 * Create an error that the Protocol base class serializes as a JSON-RPC error
 * with the given code and **exact** message string.
 *
 * We avoid `McpError` because its constructor prefixes the message with
 * "MCP error <code>: ", which would change the `error.message` field in the
 * JSON-RPC response.
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
// Tool registration (populates tools/list)
// ---------------------------------------------------------------------------

// Raw Zod shapes for McpServer.tool() registration (tools/list exposure).
// The actual validation + dispatch is handled by the custom CallTool handler
// below so that validation failures surface as JSON-RPC -32602 errors (not
// tool results with isError).

const noop = async () => ({
  content: [{ type: "text" as const, text: "" }],
});

// read
server.tool(
  "read",
  "Read a file from disk, optionally pruning the output",
  readInputSchema,
  noop,
);

// bash
server.tool(
  "bash",
  "Execute a shell command, optionally pruning the output",
  {
    command: z.string().describe("Shell command to run"),
    context_focus_question: z
      .string()
      .optional()
      .describe("Optional question to focus the pruned output on"),
  },
  noop,
);

// grep
server.tool(
  "grep",
  "Search files with grep, optionally pruning the output",
  {
    pattern: z.string().describe("Pattern to search for (regex)"),
    path: z
      .string()
      .optional()
      .describe("File/dir path to search; defaults to '.'"),
    context_focus_question: z
      .string()
      .optional()
      .describe("Optional question to focus the pruned output on"),
  },
  noop,
);

// ---------------------------------------------------------------------------
// Validation schemas (used by the custom CallTool handler)
// ---------------------------------------------------------------------------

const ReadSchema = z.object({
  file_path: z.string(),
  context_focus_question: z.string().optional(),
});

const BashSchema = z.object({
  command: z.string(),
  context_focus_question: z.string().optional(),
});

const GrepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  context_focus_question: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Custom CallTool handler
//
// Overrides the SDK's default handler so that:
//   • Validation failures throw an error with code -32602 and message
//     "Invalid params" (exact string), which the Protocol base class converts
//     to a proper JSON-RPC error response.
//   • Tool execution results use { content: [{ type: "text", text }] } and
//     never set isError.
// ---------------------------------------------------------------------------

server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = rawArgs ?? {};

  const cwd = process.env.MCP_PRUNER_CWD || process.cwd();
  const prunerConfig = getPrunerConfig();

  switch (name) {
    case "read": {
      const parsed = ReadSchema.safeParse(args);
      if (!parsed.success) {
        throw jsonRpcError(ErrorCode.InvalidParams, "Invalid params");
      }
      return handleRead(parsed.data, { cwd, prunerConfig });
    }

    case "bash": {
      const parsed = BashSchema.safeParse(args);
      if (!parsed.success) {
        throw jsonRpcError(ErrorCode.InvalidParams, "Invalid params");
      }
      return handleBash(parsed.data, cwd, prunerConfig);
    }

    case "grep": {
      const parsed = GrepSchema.safeParse(args);
      if (!parsed.success) {
        throw jsonRpcError(ErrorCode.InvalidParams, "Invalid params");
      }
      return handleGrep(parsed.data);
    }

    default:
      throw jsonRpcError(
        ErrorCode.InvalidParams,
        `Tool ${name} not found`,
      );
  }
});

// ---------------------------------------------------------------------------
// Start
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
