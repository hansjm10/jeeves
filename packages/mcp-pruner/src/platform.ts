import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface PlatformResolveDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathLookup?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => SpawnSyncReturns<string>;
  fileExists?: (filePath: string) => boolean;
}

export interface ShellCommand {
  command: string;
  argsPrefix: readonly string[];
}

function defaultPathLookup(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

function defaultFileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeCandidatePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^"+|"+$/g, "");
}

function findOnPath(
  command: string,
  deps: Required<Pick<PlatformResolveDeps, "platform" | "env">> &
    Pick<PlatformResolveDeps, "pathLookup" | "fileExists">,
): string | undefined {
  const lookup = deps.platform === "win32" ? "where" : "which";
  const pathLookup = deps.pathLookup ?? defaultPathLookup;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const result = pathLookup(lookup, [command], deps.env);
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }

  for (const line of result.stdout.split(/\r?\n/)) {
    const candidate = normalizeCandidatePath(line);
    if (!candidate) continue;
    if (fileExists(candidate)) return candidate;
  }

  return undefined;
}

function windowsGitCandidates(
  env: NodeJS.ProcessEnv,
  executableName: "bash.exe" | "grep.exe",
): string[] {
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : undefined,
  ].filter((value): value is string => Boolean(value && value.trim()));

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(path.join(root, "Git", "bin", executableName));
    candidates.push(path.join(root, "Git", "usr", "bin", executableName));
  }

  return candidates;
}

export function resolveShellCommand(rawDeps: PlatformResolveDeps = {}): ShellCommand | null {
  const platform = rawDeps.platform ?? process.platform;
  const env = rawDeps.env ?? process.env;
  const fileExists = rawDeps.fileExists ?? defaultFileExists;

  const explicit = env.MCP_PRUNER_BASH_PATH?.trim();
  if (explicit) {
    if (fileExists(explicit)) return { command: explicit, argsPrefix: ["-c"] };
    process.stderr.write(
      `[mcp-pruner] Warning: MCP_PRUNER_BASH_PATH is not readable: ${explicit}\n`,
    );
  }

  if (platform !== "win32") {
    return { command: "/bin/sh", argsPrefix: ["-c"] };
  }

  const pathResolved = findOnPath("bash", { platform, env, pathLookup: rawDeps.pathLookup, fileExists });
  if (pathResolved) return { command: pathResolved, argsPrefix: ["-c"] };

  for (const candidate of windowsGitCandidates(env, "bash.exe")) {
    if (fileExists(candidate)) return { command: candidate, argsPrefix: ["-c"] };
  }

  return null;
}

export function resolveGrepCommand(rawDeps: PlatformResolveDeps = {}): string | null {
  const platform = rawDeps.platform ?? process.platform;
  const env = rawDeps.env ?? process.env;
  const fileExists = rawDeps.fileExists ?? defaultFileExists;

  const explicit = env.MCP_PRUNER_GREP_PATH?.trim();
  if (explicit) {
    if (fileExists(explicit)) return explicit;
    process.stderr.write(
      `[mcp-pruner] Warning: MCP_PRUNER_GREP_PATH is not readable: ${explicit}\n`,
    );
  }

  const pathResolved = findOnPath("grep", { platform, env, pathLookup: rawDeps.pathLookup, fileExists });
  if (pathResolved) return pathResolved;

  if (platform === "win32") {
    for (const candidate of windowsGitCandidates(env, "grep.exe")) {
      if (fileExists(candidate)) return candidate;
    }
  }

  return null;
}
