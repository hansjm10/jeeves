/**
 * MCP bash tool handler.
 *
 * Executes shell commands and returns formatted output with optional
 * context-focus pruning.
 */

import { execFile } from "node:child_process";
import { z } from "zod";
import { type PrunerConfig, pruneContent } from "../pruner.js";

/** Zod schema for bash tool input arguments. */
export const BashInputSchema = z.object({
  command: z.string(),
  context_focus_question: z.string().optional(),
});

export type BashInput = z.infer<typeof BashInputSchema>;

/**
 * Format bash output per the issue specification:
 *
 * - Start with stdout.
 * - If stderr is non-empty, append `\n[stderr]\n<stderr>`.
 * - If exit code !== 0 (including null), append `\n[exit code: <code>]`.
 * - If the assembled output is empty, return `(no output)`.
 */
function formatOutput(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  let output = stdout;

  if (stderr.length > 0) {
    output += `\n[stderr]\n${stderr}`;
  }

  if (exitCode !== 0) {
    output += `\n[exit code: ${exitCode}]`;
  }

  if (output.length === 0) {
    return "(no output)";
  }

  return output;
}

/**
 * Execute a bash command and return a formatted tool result.
 *
 * The result is always `{ content: [{ type: "text", text }] }` and never
 * sets `isError`. Spawn failures are surfaced as error text in the content.
 *
 * @param args      - Validated bash tool arguments.
 * @param cwd       - Working directory for the command (from MCP_PRUNER_CWD).
 * @param config    - Pruner configuration for optional pruning.
 */
export async function handleBash(
  args: BashInput,
  cwd: string,
  config: PrunerConfig,
): Promise<{ content: { type: "text"; text: string }[] }> {
  let rawOutput: string;
  let isSpawnError = false;

  try {
    rawOutput = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "/bin/sh",
        ["-c", args.command],
        { cwd },
        (error, stdout, stderr) => {
          if (error) {
            // Check for a numeric exit code (normal command failure).
            const numericCode =
              typeof error.code === "number" ? error.code : null;
            if (numericCode !== null) {
              resolve(formatOutput(stdout ?? "", stderr ?? "", numericCode));
              return;
            }

            // No numeric exit code means a spawn-level failure (e.g. ENOENT,
            // EACCES on the shell binary itself, or the child was killed).
            reject(error);
            return;
          }

          // Successful execution (exit code 0).
          resolve(formatOutput(stdout ?? "", stderr ?? "", 0));
        },
      );

      // Handle spawn errors that fire before the callback.
      child.on("error", (err) => {
        reject(err);
      });
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    rawOutput = `Error executing command: ${message}`;
    isSpawnError = true;
  }

  // Pruning eligibility: when context_focus_question is provided and truthy,
  // and the output is not "(no output)" or a spawn error, attempt pruning.
  // Per the design doc: "(no output)" is never pruned; spawn error strings
  // are never pruned.
  if (
    !isSpawnError &&
    rawOutput !== "(no output)" &&
    args.context_focus_question &&
    config.enabled
  ) {
    rawOutput = await pruneContent(
      rawOutput,
      args.context_focus_question,
      config,
    );
  }

  return {
    content: [{ type: "text", text: rawOutput }],
  };
}
