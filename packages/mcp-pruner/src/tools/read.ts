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
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional 1-based start line for focused reads (inclusive)"),
  end_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional 1-based end line for focused reads (inclusive)"),
  around_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional 1-based anchor line for around/radius reads"),
  radius: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe("Optional radius used with around_line (default 20)"),
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
  args: {
    file_path: string;
    start_line?: number;
    end_line?: number;
    around_line?: number;
    radius?: number;
    context_focus_question?: string;
  },
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

  const hasRangeWindow = args.start_line !== undefined && args.end_line !== undefined;
  const hasAroundWindow = args.around_line !== undefined;
  if (hasRangeWindow || hasAroundWindow) {
    const allLines = fileContent.split(/\r?\n/);
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    const radius = args.radius ?? 20;
    const startLine = hasRangeWindow
      ? args.start_line!
      : Math.max(1, (args.around_line as number) - radius);
    const endLine = hasRangeWindow
      ? args.end_line!
      : (args.around_line as number) + radius;

    const boundedStart = Math.max(1, startLine);
    const boundedEnd = Math.min(allLines.length, endLine);
    if (allLines.length === 0 || boundedStart > boundedEnd) {
      fileContent = "(no lines in range)";
    } else {
      const windowLines: string[] = [];
      for (let lineNo = boundedStart; lineNo <= boundedEnd; lineNo += 1) {
        windowLines.push(`${lineNo}: ${allLines[lineNo - 1] ?? ""}`);
      }
      fileContent = `${windowLines.join("\n")}\n`;
    }
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
