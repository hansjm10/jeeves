#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getPrunerConfig } from "./pruner.js";
import { readInputSchema, handleRead } from "./tools/read.js";
import { BashInputSchema, handleBash } from "./tools/bash.js";
import { GrepArgsSchema, handleGrep } from "./tools/grep.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a JSON-RPC error that the protocol layer will serialize with the
 * exact `message` we provide (unlike McpError whose super() prepends
 * "MCP error <code>: ").
 */
function jsonRpcError(code: number, message: string): Error {
  const err = new Error(message);
  (err as Error & { code: number }).code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Server instance
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-pruner",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Resolve shared dependencies for tool handlers
// ---------------------------------------------------------------------------

const cwd = process.env.MCP_PRUNER_CWD || process.cwd();
const prunerConfig = getPrunerConfig();

// ---------------------------------------------------------------------------
// Register tools for tools/list schema exposure.
// The callbacks below are never called because we override the CallTool
// handler further down to enforce JSON-RPC -32602 for invalid params and
// to ensure tool results never set isError.
// ---------------------------------------------------------------------------

server.tool(
  "read",
  "Read file contents with optional context-focused pruning",
  readInputSchema,
  async () => ({ content: [{ type: "text" as const, text: "" }] }),
);

server.tool(
  "bash",
  "Execute a shell command with optional context-focused pruning",
  {
    command: z.string().describe("Shell command to run"),
    context_focus_question: z
      .string()
      .optional()
      .describe("Optional question to focus the pruned output on"),
  },
  async () => ({ content: [{ type: "text" as const, text: "" }] }),
);

server.tool(
  "grep",
  "Search files with grep and optional context-focused pruning",
  {
    pattern: z.string().describe("Pattern to search for (regex)"),
    path: z
      .string()
      .optional()
      .describe("File/dir path to search (defaults to '.')"),
    context_focus_question: z
      .string()
      .optional()
      .describe("Optional question to focus the pruned output on"),
  },
  async () => ({ content: [{ type: "text" as const, text: "" }] }),
);

// ---------------------------------------------------------------------------
// Override the tools/call handler to:
// 1. Return JSON-RPC -32602 with exact message "Invalid params" on validation
//    failure (the SDK default wraps validation errors as tool results with
//    isError, which does not match the issue spec).
// 2. Ensure tool results use { content: [{ type:"text", text }] } without
//    setting isError.
// ---------------------------------------------------------------------------

// Build Zod object schemas for validation.
const readSchema = z.object(readInputSchema);
const bashSchema = BashInputSchema;
const grepSchema = GrepArgsSchema;

server.server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    const toolName = request.params.name;
    const rawArgs = request.params.arguments ?? {};

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
  },
);

// ---------------------------------------------------------------------------
// Start the server
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
