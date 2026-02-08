import { describe, expect, it } from "vitest";

import {
  resolveGrepCommand,
  resolveShellCommand,
} from "./platform.js";

function makePathLookup(
  stdoutByCommand: Record<string, string>,
): (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => import("node:child_process").SpawnSyncReturns<string> {
  return (
    command: string,
    args: readonly string[],
  ) => {
    const key = `${command} ${args.join(" ")}`;
    const stdout = stdoutByCommand[key] ?? "";
    const status = stdout ? 0 : 1;
    return {
      pid: 1,
      output: [null, stdout, ""],
      stdout,
      stderr: "",
      status,
      signal: null,
    };
  };
}

describe("platform helpers", () => {
  describe("resolveShellCommand", () => {
    it("uses MCP_PRUNER_BASH_PATH when provided and readable", () => {
      const shell = resolveShellCommand({
        platform: "win32",
        env: { MCP_PRUNER_BASH_PATH: "C:\\Git\\bin\\bash.exe" },
        fileExists: (filePath) => filePath === "C:\\Git\\bin\\bash.exe",
      });
      expect(shell).toEqual({
        command: "C:\\Git\\bin\\bash.exe",
        argsPrefix: ["-c"],
      });
    });

    it("resolves bash from PATH on windows", () => {
      const shell = resolveShellCommand({
        platform: "win32",
        env: {},
        pathLookup: makePathLookup({
          "where bash": "C:\\Tools\\bash.exe\n",
        }),
        fileExists: (filePath) => filePath === "C:\\Tools\\bash.exe",
      });
      expect(shell?.command).toBe("C:\\Tools\\bash.exe");
    });

    it("returns null on windows when no bash implementation is available", () => {
      const shell = resolveShellCommand({
        platform: "win32",
        env: {},
        pathLookup: makePathLookup({}),
        fileExists: () => false,
      });
      expect(shell).toBeNull();
    });
  });

  describe("resolveGrepCommand", () => {
    it("uses MCP_PRUNER_GREP_PATH when provided and readable", () => {
      const grep = resolveGrepCommand({
        platform: "win32",
        env: { MCP_PRUNER_GREP_PATH: "C:\\Git\\usr\\bin\\grep.exe" },
        fileExists: (filePath) => filePath === "C:\\Git\\usr\\bin\\grep.exe",
      });
      expect(grep).toBe("C:\\Git\\usr\\bin\\grep.exe");
    });

    it("resolves grep from PATH when available", () => {
      const grep = resolveGrepCommand({
        platform: "linux",
        env: {},
        pathLookup: makePathLookup({
          "which grep": "/usr/bin/grep\n",
        }),
        fileExists: (filePath) => filePath === "/usr/bin/grep",
      });
      expect(grep).toBe("/usr/bin/grep");
    });

    it("returns null when grep cannot be found", () => {
      const grep = resolveGrepCommand({
        platform: "linux",
        env: {},
        pathLookup: makePathLookup({}),
        fileExists: () => false,
      });
      expect(grep).toBeNull();
    });
  });
});
