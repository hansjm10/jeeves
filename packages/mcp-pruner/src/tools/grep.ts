/**
 * MCP grep tool handler.
 *
 * Executes `grep -rn --color=never <pattern> <path>` and returns results with
 * optional context-focus pruning.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import { getPrunerConfig, pruneContent } from "../pruner.js";

/** Zod schema for grep tool arguments. */
export const GrepArgsSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  context_focus_question: z.string().optional(),
});

export type GrepArgs = z.infer<typeof GrepArgsSchema>;

/**
 * Execute grep and collect stdout, stderr, and exit code.
 *
 * @returns A promise resolving to `{ stdout, stderr, exitCode }` on normal
 *   exit, or rejecting with a spawn error.
 */
function execGrep(
  pattern: string,
  searchPath: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("grep", ["-rn", "--color=never", pattern, searchPath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      reject(err);
    });

    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/**
 * Handle a grep tool call.
 *
 * @returns MCP tool result with `{ content: [{ type: "text", text }] }`.
 *   Never sets `isError`.
 */
export async function handleGrep(
  args: GrepArgs,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const cwd = process.env.MCP_PRUNER_CWD || process.cwd();
  const searchPath = args.path ?? ".";

  let text: string;
  let isPruneable = false;

  try {
    const { stdout, stderr, exitCode } = await execGrep(
      args.pattern,
      searchPath,
      cwd,
    );

    if (exitCode === 0) {
      // Matches found – return stdout verbatim.
      text = stdout;
      isPruneable = true;
    } else if (exitCode === 1) {
      // No matches.
      text = "(no matches found)";
    } else {
      // Exit code 2 (or other non-0/1).
      if (stderr.length > 0) {
        text = `Error: ${stderr}`;
      } else if (stdout.length > 0) {
        text = stdout;
        isPruneable = true;
      } else {
        text = "(no matches found)";
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    text = `Error executing grep: ${message}`;
  }

  // Attempt pruning when eligible.
  if (
    isPruneable &&
    text.length > 0 &&
    args.context_focus_question
  ) {
    const config = getPrunerConfig();
    text = await pruneContent(text, args.context_focus_question, config);
  }

  return { content: [{ type: "text", text }] };
}
