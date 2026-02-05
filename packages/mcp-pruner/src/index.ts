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
import { handleRead, readInputSchema } from "./tools/read.js";

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-pruner",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool input schemas (raw Zod shapes for McpServer.tool registration)
// ---------------------------------------------------------------------------

const bashRawSchema = {
  command: z.string().describe("Shell command to run"),
  context_focus_question: z
    .string()
    .optional()
    .describe("Optional question to focus the pruned output on"),
};

const grepRawSchema = {
  pattern: z.string().describe("Pattern to search for (regex)"),
  path: z.string().optional().describe("File/dir path to search; defaults to '.'"),
  context_focus_question: z
    .string()
    .optional()
    .describe("Optional question to focus the pruned output on"),
};

// ---------------------------------------------------------------------------
// Register tools on the McpServer (exposes them via tools/list).
// The callback is a no-op placeholder; actual dispatch is handled by the
// custom tools/call handler below to enforce the exact JSON-RPC -32602
// behaviour required by the spec.
// ---------------------------------------------------------------------------

const noop = () => ({ content: [{ type: "text" as const, text: "" }] });

server.tool("read", readInputSchema, noop);
server.tool("bash", bashRawSchema, noop);
server.tool("grep", grepRawSchema, noop);

// ---------------------------------------------------------------------------
// Zod object schemas for manual validation in the custom tools/call handler
// ---------------------------------------------------------------------------

const readSchema = z.object({
  file_path: z.string(),
  context_focus_question: z.string().optional(),
});

const bashSchema = z.object({
  command: z.string(),
  context_focus_question: z.string().optional(),
});

const grepSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  context_focus_question: z.string().optional(),
});

const toolSchemas: Record<string, z.ZodTypeAny> = {
  read: readSchema,
  bash: bashSchema,
  grep: grepSchema,
};

// ---------------------------------------------------------------------------
// JSON-RPC error helper
//
// McpError's constructor prefixes the message with "MCP error <code>: ",
// which prevents us from returning the exact "Invalid params" message
// required by the spec.  We create a plain Error with a numeric `code`
// property instead — the SDK protocol layer reads `error['code']` and
// `error.message` directly when serialising the JSON-RPC error response.
// ---------------------------------------------------------------------------

function invalidParamsError(): Error & { code: number } {
  const err = new Error("Invalid params") as Error & { code: number };
  err.code = ErrorCode.InvalidParams; // -32602
  return err;
}

// ---------------------------------------------------------------------------
// Custom tools/call handler
//
// Overrides the default McpServer handler so that:
//   1. Invalid params throw JSON-RPC -32602 with message "Invalid params".
//   2. Tool results use { content: [{ type: "text", text }] } and never
//      set result.isError.
// ---------------------------------------------------------------------------

server.server.setRequestHandler(
  CallToolRequestSchema,
  async (request) => {
    const { name, arguments: rawArgs } = request.params;

    // Unknown tool → -32602
    const schema = toolSchemas[name];
    if (!schema) {
      throw invalidParamsError();
    }

    // Validate arguments → -32602 on failure
    const parseResult = schema.safeParse(rawArgs ?? {});
    if (!parseResult.success) {
      throw invalidParamsError();
    }

    const args = parseResult.data as Record<string, unknown>;

    // Resolve runtime deps
    const cwd = process.env.MCP_PRUNER_CWD || process.cwd();
    const prunerConfig = getPrunerConfig();

    // Dispatch to tool handler
    switch (name) {
      case "read":
        return handleRead(
          args as { file_path: string; context_focus_question?: string },
          { cwd, prunerConfig },
        );

      case "bash":
        return handleBash(
          args as { command: string; context_focus_question?: string },
          cwd,
          prunerConfig,
        );

      case "grep":
        return handleGrep(
          args as {
            pattern: string;
            path?: string;
            context_focus_question?: string;
          },
        );

      default:
        throw invalidParamsError();
    }
  },
);

// ---------------------------------------------------------------------------
// Start server
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
