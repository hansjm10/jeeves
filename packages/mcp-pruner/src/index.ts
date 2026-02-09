#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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

/**
 * Normalize an initialize request's params so that the SDK's strict schema
 * validation succeeds even when optional-by-convention fields are absent.
 *
 * The MCP spec's initialize request requires `protocolVersion`, `clientInfo`,
 * and `capabilities`. However, lightweight clients (and the project's own
 * smoke-test) may send only `{"capabilities":{}}`. We fill in sensible
 * defaults for any missing required fields so the SDK handles the request
 * normally while remaining compatible with strict clients.
 */
function normalizeInitializeParams(
  message: Record<string, unknown>,
): void {
  if (
    typeof message !== "object" ||
    message === null ||
    message.method !== "initialize"
  ) {
    return;
  }

  // If params is absent or not an object, provide a minimal valid object.
  // If it's present but a non-object (e.g. a string), leave it as-is so the
  // SDK's schema validation rejects it with a proper error.
  if (message.params === undefined || message.params === null) {
    message.params = {};
  }

  if (typeof message.params !== "object" || Array.isArray(message.params)) {
    return; // Let the SDK reject it
  }

  const params = message.params as Record<string, unknown>;

  // Fill in missing fields only (undefined → default).  If the field is
  // present with a wrong type (e.g. protocolVersion: 123), leave it for the
  // SDK to reject.
  if (params.protocolVersion === undefined) {
    params.protocolVersion = LATEST_PROTOCOL_VERSION;
  }
  if (params.clientInfo === undefined) {
    params.clientInfo = { name: "unknown", version: "0.0.0" };
  }
  if (params.capabilities === undefined) {
    params.capabilities = {};
  }
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
  pattern: z
    .string()
    .optional()
    .describe("Single pattern to search for (regex)"),
  patterns: z
    .array(z.string())
    .min(1)
    .max(50)
    .optional()
    .describe("Batch patterns to search in one tool call"),
  path: z
    .string()
    .optional()
    .describe("File/dir path to search (defaults to '.')"),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Optional context lines around grep matches"),
  max_matches: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Optional max output lines before truncation"),
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

const readSchema = z
  .object(readInputSchema)
  .strict()
  .superRefine((value, ctx) => {
    const hasStart = value.start_line !== undefined;
    const hasEnd = value.end_line !== undefined;
    const hasAround = value.around_line !== undefined;
    const hasRadius = value.radius !== undefined;
    const hasRange = hasStart || hasEnd;

    if (hasRange && (!hasStart || !hasEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "start_line and end_line must be provided together",
        path: ["start_line"],
      });
    }

    if (hasStart && hasEnd && value.start_line! > value.end_line!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "start_line must be <= end_line",
        path: ["start_line"],
      });
    }

    if (hasRadius && !hasAround) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "radius requires around_line",
        path: ["radius"],
      });
    }

    if (hasRange && hasAround) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use either start/end range or around_line/radius, not both",
        path: ["around_line"],
      });
    }
  });
const bashSchema = z.object(bashInputShape).strict();
const grepSchema = z
  .object(grepInputShape)
  .strict()
  .superRefine((value, ctx) => {
    const hasPattern = value.pattern !== undefined;
    const hasPatterns = value.patterns !== undefined;
    if (hasPattern === hasPatterns) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of pattern or patterns is required",
        path: ["pattern"],
      });
    }
  });

const GREP_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const GREP_DUPLICATE_CACHE_LIMIT = 512;
const grepQueryHistory = new Map<string, number>();

function makeGrepQueryKey(args: {
  pattern?: string;
  patterns?: string[];
  path?: string;
  context_lines?: number;
  max_matches?: number;
}): string {
  return JSON.stringify({
    pattern: args.pattern ?? null,
    patterns: args.patterns ?? null,
    path: args.path ?? ".",
    context_lines: args.context_lines ?? 0,
    max_matches: args.max_matches ?? 200,
  });
}

function isDuplicateGrepQuery(args: {
  pattern?: string;
  patterns?: string[];
  path?: string;
  context_lines?: number;
  max_matches?: number;
}): boolean {
  const now = Date.now();
  for (const [key, ts] of grepQueryHistory) {
    if (now - ts > GREP_DUPLICATE_WINDOW_MS) {
      grepQueryHistory.delete(key);
    }
  }

  const key = makeGrepQueryKey(args);
  const prev = grepQueryHistory.get(key);
  grepQueryHistory.set(key, now);

  while (grepQueryHistory.size > GREP_DUPLICATE_CACHE_LIMIT) {
    const firstKey = grepQueryHistory.keys().next().value;
    if (firstKey === undefined) break;
    grepQueryHistory.delete(firstKey);
  }

  return prev !== undefined && now - prev <= GREP_DUPLICATE_WINDOW_MS;
}

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
      const duplicate = isDuplicateGrepQuery(parsed.data);
      const result = await handleGrep(parsed.data);
      if (duplicate && result.content[0]) {
        result.content[0].text =
          `[diagnostic] duplicate grep query detected; prefer read around prior anchor.\n${result.content[0].text}`;
      }
      return result;
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

  // ---------------------------------------------------------------------------
  // Intercept incoming messages to normalize incomplete-but-valid initialize
  // requests (e.g. the issue's smoke-test payload that sends only
  // {"capabilities":{}}) so that the SDK's strict schema validation succeeds.
  //
  // Also intercept outgoing messages to convert any SDK validation errors for
  // the initialize method into the project's required JSON-RPC -32602 /
  // "Invalid params" shape (the SDK defaults to -32603 with Zod details).
  // ---------------------------------------------------------------------------

  // Track which request IDs are for initialize so we can scope error rewrites.
  const initializeRequestIds = new Set<unknown>();

  const sdkOnMessage = transport.onmessage as
    | ((message: JSONRPCMessage, extra?: unknown) => void)
    | undefined;
  transport.onmessage = ((message: JSONRPCMessage, extra?: unknown) => {
    const msg = message as Record<string, unknown>;
    if (msg.method === "initialize" && msg.id !== undefined) {
      initializeRequestIds.add(msg.id);
      normalizeInitializeParams(msg);
    }
    if (sdkOnMessage) sdkOnMessage(message, extra);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const sdkSend = transport.send.bind(transport) as (
    message: JSONRPCMessage,
    options?: unknown,
  ) => Promise<void>;
  transport.send = (async (
    message: JSONRPCMessage,
    options?: unknown,
  ) => {
    const msg = message as Record<string, unknown>;
    // Rewrite initialize validation errors to -32602 "Invalid params".
    // The SDK emits -32603 (InternalError) for Zod schema failures; we
    // convert those to the project-required -32602 shape for initialize.
    if (
      typeof msg.error === "object" &&
      msg.error !== null &&
      msg.id !== undefined &&
      initializeRequestIds.has(msg.id)
    ) {
      initializeRequestIds.delete(msg.id);
      const err = msg.error as Record<string, unknown>;
      if (typeof err.code === "number" && err.code !== ErrorCode.InvalidParams) {
        err.code = ErrorCode.InvalidParams;
        err.message = "Invalid params";
      }
    } else if (msg.id !== undefined) {
      initializeRequestIds.delete(msg.id);
    }
    return sdkSend(message, options);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  process.stderr.write("[mcp-pruner] Server started on stdio\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`[mcp-pruner] Fatal error: ${String(error)}\n`);
  process.exit(1);
});
