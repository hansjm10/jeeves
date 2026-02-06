/**
 * MCP read tool handler.
 *
 * Reads a file from disk and optionally prunes the output via the swe-pruner
 * HTTP endpoint when context_focus_question is provided.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type PrunerConfig, pruneContent } from "../pruner.js";

// ---------------------------------------------------------------------------
// Input schema (Zod raw shape for McpServer.tool / registerTool)
// ---------------------------------------------------------------------------

export const readInputSchema = {
  file_path: z.string().describe("Absolute or relative path to the file to read"),
  context_focus_question: z
    .string()
    .optional()
    .describe("Optional question to focus the pruned output on"),
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface ReadToolDeps {
  /** Resolved working directory (MCP_PRUNER_CWD or process.cwd()). */
  cwd: string;
  /** Pruner configuration (from getPrunerConfig). */
  prunerConfig: PrunerConfig;
}

/**
 * Read tool handler.
 *
 * @returns An MCP tool result: `{ content: [{ type: "text", text }] }`.
 *          Never sets `isError`.
 */
export async function handleRead(
  args: { file_path: string; context_focus_question?: string },
  deps: ReadToolDeps,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const { cwd, prunerConfig } = deps;

  // Resolve the file path: absolute paths used as-is, relative resolved against cwd.
  const resolvedPath = path.isAbsolute(args.file_path)
    ? args.file_path
    : path.resolve(cwd, args.file_path);

  // Attempt to read the file.
  let fileContent: string;
  try {
    fileContent = await readFile(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Return error text in content; do NOT set isError.
    return {
      content: [{ type: "text", text: `Error reading file: ${message}` }],
    };
  }

  // Pruning: attempt when context_focus_question is truthy and pruning is enabled.
  // Pruning is eligible even for empty file contents ("").
  // Pruning is NOT attempted for the error string (returned early above).
  if (args.context_focus_question && prunerConfig.enabled) {
    const pruned = await pruneContent(
      fileContent,
      args.context_focus_question,
      prunerConfig,
    );
    return {
      content: [{ type: "text", text: pruned }],
    };
  }

  return {
    content: [{ type: "text", text: fileContent }],
  };
}
