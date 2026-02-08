/**
 * MCP grep tool handler.
 *
 * Executes `grep -Ern --color=never <pattern> <path>` and returns results with
 * optional context-focus pruning.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getPrunerConfig, pruneContent } from "../pruner.js";
import {
  resolveGrepCommand,
  type PlatformResolveDeps,
} from "../platform.js";

/** Zod schema for grep tool arguments. */
export const GrepArgsSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  context_focus_question: z.string().optional(),
});

export type GrepArgs = z.infer<typeof GrepArgsSchema>;

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface GrepRuntimeDeps extends PlatformResolveDeps {
  cwd?: string;
  spawnImpl?: SpawnLike;
  grepCommand?: string | null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isGrepSpawnErrorFallbackCandidate(err: unknown): boolean {
  if (!isNodeError(err)) return false;
  return err.code === "ENOENT" || err.code === "EACCES";
}

function toDisplayPath(cwd: string, filePath: string): string {
  const rel = path.relative(cwd, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return filePath.replace(/\\/g, "/");
  }
  return rel.replace(/\\/g, "/");
}

async function collectFiles(searchRoot: string): Promise<string[]> {
  const stack = [searchRoot];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if (isNodeError(err)) {
        throw new Error(`${current}: ${err.message}`);
      }
      throw err;
    }

    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      files.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (isNodeError(err)) {
        throw new Error(`${current}: ${err.message}`);
      }
      throw err;
    }

    for (const entry of entries) {
      stack.push(path.join(current, entry.name));
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function lineMatches(regex: RegExp, line: string): boolean {
  if (regex.global || regex.sticky) regex.lastIndex = 0;
  return regex.test(line);
}

async function execGrepFallback(
  pattern: string,
  searchPath: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: `${message}\n`,
      exitCode: 2,
    };
  }

  const searchRoot = path.isAbsolute(searchPath)
    ? searchPath
    : path.resolve(cwd, searchPath);

  let files: string[];
  try {
    files = await collectFiles(searchRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: `${message}\n`,
      exitCode: 2,
    };
  }

  let stdout = "";
  let stderr = "";
  let hasMatches = false;
  let hasError = false;

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stderr += `${toDisplayPath(cwd, filePath)}: ${message}\n`;
      hasError = true;
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!lineMatches(regex, line)) continue;
      stdout += `${toDisplayPath(cwd, filePath)}:${i + 1}:${line}\n`;
      hasMatches = true;
    }
  }

  if (hasError) return { stdout, stderr, exitCode: 2 };
  if (hasMatches) return { stdout, stderr: "", exitCode: 0 };
  return { stdout: "", stderr: "", exitCode: 1 };
}

/**
 * Execute grep and collect stdout, stderr, and exit code.
 *
 * @returns A promise resolving to `{ stdout, stderr, exitCode }` on normal
 *   exit, or rejecting with a spawn error.
 */
function execExternalGrep(
  grepCommand: string,
  pattern: string,
  searchPath: string,
  cwd: string,
  spawnImpl: SpawnLike,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      grepCommand,
      // Use ERE so alternation like `foo|bar` behaves as expected.
      ["-Ern", "--color=never", pattern, searchPath],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    if (!child.stdout || !child.stderr) {
      reject(new Error("grep subprocess missing stdout/stderr pipes"));
      return;
    }

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

async function execGrep(
  args: {
    pattern: string;
    searchPath: string;
    cwd: string;
  },
  deps: GrepRuntimeDeps = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const grepCommand = deps.grepCommand !== undefined
    ? deps.grepCommand
    : resolveGrepCommand({
        platform: deps.platform,
        env: deps.env,
        pathLookup: deps.pathLookup,
        fileExists: deps.fileExists,
      });

  if (!grepCommand) {
    return execGrepFallback(args.pattern, args.searchPath, args.cwd);
  }

  const spawnImpl: SpawnLike = deps.spawnImpl ?? ((command, commandArgs, options) => spawn(command, commandArgs as string[], options));
  try {
    return await execExternalGrep(
      grepCommand,
      args.pattern,
      args.searchPath,
      args.cwd,
      spawnImpl,
    );
  } catch (err) {
    if (isGrepSpawnErrorFallbackCandidate(err)) {
      return execGrepFallback(args.pattern, args.searchPath, args.cwd);
    }
    throw err;
  }
}

/**
 * Handle a grep tool call.
 *
 * @returns MCP tool result with `{ content: [{ type: "text", text }] }`.
 *   Never sets `isError`.
 */
export async function handleGrep(
  args: GrepArgs,
  deps: GrepRuntimeDeps = {},
): Promise<{ content: { type: "text"; text: string }[] }> {
  const envCwd = deps.env?.MCP_PRUNER_CWD ?? process.env.MCP_PRUNER_CWD;
  const cwd = deps.cwd ?? envCwd ?? process.cwd();
  const searchPath = args.path ?? ".";

  let text: string;
  let isPruneable = false;

  try {
    const { stdout, stderr, exitCode } = await execGrep(
      {
        pattern: args.pattern,
        searchPath,
        cwd,
      },
      deps,
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
