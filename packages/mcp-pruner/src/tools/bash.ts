/**
 * MCP bash tool handler.
 *
 * Executes shell commands and returns formatted output with optional
 * context-focus pruning.
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { z } from "zod";
import { type PrunerConfig, pruneContent } from "../pruner.js";
import {
  resolveShellCommand,
  type PlatformResolveDeps,
} from "../platform.js";

/** Zod schema for bash tool input arguments. */
export const BashInputSchema = z.object({
  command: z.string(),
  context_focus_question: z.string().optional(),
});

export type BashInput = z.infer<typeof BashInputSchema>;

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    stdout: string,
    stderr: string,
  ) => void,
) => ReturnType<typeof execFile>;

export interface BashRuntimeDeps extends PlatformResolveDeps {
  execFileImpl?: ExecFileLike;
}

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
  deps: BashRuntimeDeps = {},
): Promise<{ content: { type: "text"; text: string }[] }> {
  let rawOutput: string;
  let isSpawnError = false;

  try {
    const shell = resolveShellCommand({
      platform: deps.platform,
      env: deps.env,
      pathLookup: deps.pathLookup,
      fileExists: deps.fileExists,
    });
    if (!shell) {
      throw new Error(
        "No usable bash-compatible shell found on this host. Install Git Bash or set MCP_PRUNER_BASH_PATH.",
      );
    }

    const execFileImpl = deps.execFileImpl ?? execFile;

    rawOutput = await new Promise<string>((resolve, reject) => {
      const child = execFileImpl(
        shell.command,
        [...shell.argsPrefix, args.command],
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

            // Signal-terminated processes (e.g. SIGTERM, SIGKILL) have a
            // non-numeric code (null/undefined) but include a signal property.
            // These are command completions (the process ran), not spawn
            // failures, so format them as normal output with a null exit code.
            if (
              typeof error.code !== "string" ||
              "signal" in error
            ) {
              resolve(formatOutput(stdout ?? "", stderr ?? "", null));
              return;
            }

            // String error.code (e.g. "ENOENT", "EACCES") indicates a true
            // spawn-level failure where the shell binary itself could not be
            // started.
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
