import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleBash, BashInputSchema } from "./bash.js";
import type { PrunerConfig } from "../pruner.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock the pruner module
vi.mock("../pruner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../pruner.js")>();
  return {
    ...original,
    pruneContent: vi.fn(),
  };
});

import { execFile, type ChildProcess } from "node:child_process";
import { pruneContent } from "../pruner.js";

const mockedExecFile = vi.mocked(execFile);
const mockedPruneContent = vi.mocked(pruneContent);

function makeConfig(overrides: Partial<PrunerConfig> = {}): PrunerConfig {
  return {
    url: "http://localhost:8000/prune",
    timeoutMs: 30000,
    enabled: false,
    ...overrides,
  };
}

/**
 * Helper to simulate execFile callback behavior.
 */
function simulateExecFile(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockedExecFile as any).mockImplementation((...args: unknown[]) => {
    const cb = args[3];
    const callback = cb as (error: Error | null, stdout: string, stderr: string) => void;
    if (exitCode !== null && exitCode !== 0) {
      const err = new Error(`Command failed: exit ${exitCode}`) as Error & { code: number };
      err.code = exitCode;
      callback(err, stdout, stderr);
    } else if (exitCode === 0 || exitCode === null) {
      callback(null, stdout, stderr);
    }
    // Return a mock child process with an `on` method
    return { on: vi.fn() } as unknown as ChildProcess;
  });
}

function simulateSpawnError(message: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockedExecFile as any).mockImplementation(() => {
    const child = {
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error") {
          // Fire spawn error asynchronously
          Promise.resolve().then(() => handler(new Error(message)));
        }
      }),
    };
    return child as unknown as ChildProcess;
  });
}

describe("BashInputSchema", () => {
  it("requires command and accepts optional context_focus_question", () => {
    const valid = BashInputSchema.safeParse({ command: "ls" });
    expect(valid.success).toBe(true);

    const withQuestion = BashInputSchema.safeParse({
      command: "ls",
      context_focus_question: "What files exist?",
    });
    expect(withQuestion.success).toBe(true);

    const missing = BashInputSchema.safeParse({});
    expect(missing.success).toBe(false);
  });
});

describe("handleBash", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns stdout for successful command with exit code 0", async () => {
    simulateExecFile("hello world", "", 0);

    const result = await handleBash(
      { command: "echo hello world" },
      "/workspace",
      makeConfig(),
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "hello world" }],
    });
  });

  it('appends "\\n[stderr]\\n<stderr>" when stderr is non-empty', async () => {
    simulateExecFile("output", "warning msg", 0);

    const result = await handleBash(
      { command: "some-cmd" },
      "/workspace",
      makeConfig(),
    );

    expect(result.content[0].text).toBe("output\n[stderr]\nwarning msg");
  });

  it('appends "\\n[exit code: <code>]" when exit code is non-zero', async () => {
    simulateExecFile("partial", "", 1);

    const result = await handleBash(
      { command: "failing-cmd" },
      "/workspace",
      makeConfig(),
    );

    expect(result.content[0].text).toBe("partial\n[exit code: 1]");
  });

  it("combines stderr and non-zero exit code", async () => {
    simulateExecFile("out", "err", 2);

    const result = await handleBash(
      { command: "bad-cmd" },
      "/workspace",
      makeConfig(),
    );

    expect(result.content[0].text).toBe("out\n[stderr]\nerr\n[exit code: 2]");
  });

  it('returns "(no output)" when stdout and stderr are both empty and exit code is 0', async () => {
    simulateExecFile("", "", 0);

    const result = await handleBash(
      { command: "silent-cmd" },
      "/workspace",
      makeConfig(),
    );

    expect(result.content[0].text).toBe("(no output)");
  });

  it('returns "Error executing command: <message>" on spawn error', async () => {
    simulateSpawnError("ENOENT: command not found");

    const result = await handleBash(
      { command: "nonexistent" },
      "/workspace",
      makeConfig(),
    );

    expect(result.content[0].text).toBe("Error executing command: ENOENT: command not found");
  });

  it("does not set isError on the result", async () => {
    simulateSpawnError("spawn error");

    const result = await handleBash(
      { command: "bad" },
      "/workspace",
      makeConfig(),
    );

    expect("isError" in result).toBe(false);
  });

  it("attempts pruning when context_focus_question is truthy and pruning enabled", async () => {
    simulateExecFile("big output", "", 0);
    mockedPruneContent.mockResolvedValue("pruned output");

    const result = await handleBash(
      { command: "cat file.ts", context_focus_question: "What is this?" },
      "/workspace",
      makeConfig({ enabled: true }),
    );

    expect(mockedPruneContent).toHaveBeenCalledWith(
      "big output",
      "What is this?",
      expect.objectContaining({ enabled: true }),
    );
    expect(result.content[0].text).toBe("pruned output");
  });

  it('does NOT prune "(no output)" placeholder', async () => {
    simulateExecFile("", "", 0);

    const result = await handleBash(
      { command: "empty", context_focus_question: "question" },
      "/workspace",
      makeConfig({ enabled: true }),
    );

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("(no output)");
  });

  it("does NOT prune spawn error strings", async () => {
    simulateSpawnError("spawn fail");

    const result = await handleBash(
      { command: "bad", context_focus_question: "question" },
      "/workspace",
      makeConfig({ enabled: true }),
    );

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Error executing command: spawn fail");
  });

  it("skips pruning when context_focus_question is not provided", async () => {
    simulateExecFile("output", "", 0);

    await handleBash(
      { command: "cmd" },
      "/workspace",
      makeConfig({ enabled: true }),
    );

    expect(mockedPruneContent).not.toHaveBeenCalled();
  });

  it("skips pruning when pruner is disabled", async () => {
    simulateExecFile("output", "", 0);

    await handleBash(
      { command: "cmd", context_focus_question: "q" },
      "/workspace",
      makeConfig({ enabled: false }),
    );

    expect(mockedPruneContent).not.toHaveBeenCalled();
  });
});
