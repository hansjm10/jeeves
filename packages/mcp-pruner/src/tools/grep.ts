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

const DEFAULT_MAX_MATCHES = 200;
const MAX_CONTEXT_LINES = 50;
const MAX_MAX_MATCHES = 1000;

/** Zod schema for grep tool arguments. */
export const GrepArgsSchema = z
  .object({
    pattern: z.string().optional(),
    patterns: z.array(z.string()).min(1).max(50).optional(),
    path: z.string().optional(),
    context_lines: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional(),
    max_matches: z.number().int().min(1).max(MAX_MAX_MATCHES).optional(),
    context_focus_question: z.string().optional(),
  })
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
  contextLines: number,
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
    const displayPath = toDisplayPath(cwd, filePath);
    const matchedLineIndexes: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (lineMatches(regex, line)) {
        matchedLineIndexes.push(i);
      }
    }
    if (matchedLineIndexes.length === 0) continue;
    hasMatches = true;

    if (contextLines <= 0) {
      for (const i of matchedLineIndexes) {
        stdout += `${displayPath}:${i + 1}:${lines[i] ?? ""}\n`;
      }
      continue;
    }

    type Range = { start: number; end: number; matchLines: Set<number> };
    const ranges: Range[] = [];
    for (const idx of matchedLineIndexes) {
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(lines.length - 1, idx + contextLines);
      const last = ranges[ranges.length - 1];
      if (!last || start > last.end + 1) {
        ranges.push({ start, end, matchLines: new Set<number>([idx]) });
      } else {
        last.end = Math.max(last.end, end);
        last.matchLines.add(idx);
      }
    }

    for (let r = 0; r < ranges.length; r += 1) {
      const range = ranges[r]!;
      for (let i = range.start; i <= range.end; i += 1) {
        const sep = range.matchLines.has(i) ? ":" : "-";
        stdout += `${displayPath}${sep}${i + 1}${sep}${lines[i] ?? ""}\n`;
      }
      if (r < ranges.length - 1) {
        stdout += "--\n";
      }
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
  contextLines: number,
  spawnImpl: SpawnLike,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const grepArgs = ["-Ern", "--color=never"];
    if (contextLines > 0) {
      grepArgs.push("-C", String(contextLines));
    }
    grepArgs.push(pattern, searchPath);

    const child = spawnImpl(
      grepCommand,
      // Use ERE so alternation like `foo|bar` behaves as expected.
      grepArgs,
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
    contextLines: number;
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
    return execGrepFallback(args.pattern, args.searchPath, args.cwd, args.contextLines);
  }

  const spawnImpl: SpawnLike = deps.spawnImpl ?? ((command, commandArgs, options) => spawn(command, commandArgs as string[], options));
  try {
    return await execExternalGrep(
      grepCommand,
      args.pattern,
      args.searchPath,
      args.cwd,
      args.contextLines,
      spawnImpl,
    );
  } catch (err) {
    if (isGrepSpawnErrorFallbackCandidate(err)) {
      return execGrepFallback(args.pattern, args.searchPath, args.cwd, args.contextLines);
    }
    throw err;
  }
}

function truncateMatchLines(
  output: string,
  maxMatches: number,
): { text: string; truncatedLineCount: number } {
  const lines = output.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxMatches) return { text: output, truncatedLineCount: 0 };

  const keptLines = lines.slice(0, maxMatches);
  const truncatedLineCount = lines.length - maxMatches;
  return {
    text: `${keptLines.join("\n")}\n(truncated ${truncatedLineCount} lines)\n`,
    truncatedLineCount,
  };
}

type SinglePatternResult = {
  text: string;
  pruneable: boolean;
  errored: boolean;
};

async function runSinglePattern(
  params: {
    pattern: string;
    searchPath: string;
    cwd: string;
    contextLines: number;
    maxMatches: number;
  },
  deps: GrepRuntimeDeps,
): Promise<SinglePatternResult> {
  const { stdout, stderr, exitCode } = await execGrep(
    {
      pattern: params.pattern,
      searchPath: params.searchPath,
      cwd: params.cwd,
      contextLines: params.contextLines,
    },
    deps,
  );

  if (exitCode === 0) {
    const truncated = truncateMatchLines(stdout, params.maxMatches);
    return {
      text: truncated.text,
      pruneable: truncated.text.length > 0,
      errored: false,
    };
  }

  if (exitCode === 1) {
    return {
      text: "(no matches found)",
      pruneable: false,
      errored: false,
    };
  }

  if (stderr.length > 0) {
    return {
      text: `Error: ${stderr}`,
      pruneable: false,
      errored: true,
    };
  }

  if (stdout.length > 0) {
    const truncated = truncateMatchLines(stdout, params.maxMatches);
    return {
      text: truncated.text,
      pruneable: truncated.text.length > 0,
      errored: false,
    };
  }

  return {
    text: "(no matches found)",
    pruneable: false,
    errored: false,
  };
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
  const contextLines = args.context_lines ?? 0;
  const maxMatches = args.max_matches ?? DEFAULT_MAX_MATCHES;
  const patterns = args.pattern !== undefined ? [args.pattern] : args.patterns ?? [];

  let text: string;
  let isPruneable = false;
  let hasErrors = false;

  try {
    const outputs: string[] = [];
    for (const pattern of patterns) {
      const result = await runSinglePattern(
        {
          pattern,
          searchPath,
          cwd,
          contextLines,
          maxMatches,
        },
        deps,
      );
      if (patterns.length === 1) {
        outputs.push(result.text);
      } else {
        const body = result.text.endsWith("\n") ? result.text : `${result.text}\n`;
        outputs.push(`== pattern: ${pattern} ==\n${body}`.trimEnd());
      }
      isPruneable = isPruneable || result.pruneable;
      hasErrors = hasErrors || result.errored;
    }
    text = outputs.join(patterns.length > 1 ? "\n\n" : "");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    text = `Error executing grep: ${message}`;
    hasErrors = true;
  }

  // Attempt pruning when eligible.
  if (
    isPruneable &&
    !hasErrors &&
    text.length > 0 &&
    args.context_focus_question
  ) {
    const config = getPrunerConfig();
    text = await pruneContent(text, args.context_focus_question, config);
  }

  return { content: [{ type: "text", text }] };
}
