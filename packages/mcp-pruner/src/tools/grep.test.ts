import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleGrep, GrepArgsSchema } from "./grep.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock the pruner module
vi.mock("../pruner.js", () => ({
  getPrunerConfig: vi.fn(),
  pruneContent: vi.fn(),
}));

import { spawn } from "node:child_process";
import { getPrunerConfig, pruneContent } from "../pruner.js";
import { EventEmitter } from "node:events";

const mockedSpawn = vi.mocked(spawn);
const mockedGetPrunerConfig = vi.mocked(getPrunerConfig);
const mockedPruneContent = vi.mocked(pruneContent);

/**
 * Create a mock child process that uses EventEmitter for stdout/stderr
 * data events and emits close with the given exit code.
 */
function createMockChild(stdout: string, stderr: string, exitCode: number): unknown {
  const child = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  (child as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (child as unknown as Record<string, unknown>).stderr = stderrEmitter;

  // Emit data and close events asynchronously so the listeners are attached first
  setImmediate(() => {
    if (stdout) stdoutEmitter.emit("data", Buffer.from(stdout));
    if (stderr) stderrEmitter.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });

  return child;
}

function createSpawnErrorChild(message: string): unknown {
  const child = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  (child as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (child as unknown as Record<string, unknown>).stderr = stderrEmitter;

  setImmediate(() => {
    child.emit("error", new Error(message));
  });

  return child;
}

describe("GrepArgsSchema", () => {
  it("requires pattern and accepts optional path and context_focus_question", () => {
    const valid = GrepArgsSchema.safeParse({ pattern: "foo" });
    expect(valid.success).toBe(true);

    const withPath = GrepArgsSchema.safeParse({ pattern: "foo", path: "src/" });
    expect(withPath.success).toBe(true);

    const withAll = GrepArgsSchema.safeParse({
      pattern: "foo",
      path: "src/",
      context_focus_question: "What is foo?",
    });
    expect(withAll.success).toBe(true);

    const missing = GrepArgsSchema.safeParse({});
    expect(missing.success).toBe(false);
  });
});

describe("handleGrep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: false,
    });
  });

  it('runs "grep -rn --color=never <pattern> <path>" with path defaulting to "."', async () => {
    mockedSpawn.mockReturnValue(createMockChild("match:1:hello", "", 0) as ReturnType<typeof spawn>);

    const result = await handleGrep({ pattern: "hello" });

    expect(mockedSpawn).toHaveBeenCalledWith(
      "grep",
      ["-rn", "--color=never", "hello", "."],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(result.content[0].text).toBe("match:1:hello");
  });

  it("uses provided path instead of default", async () => {
    mockedSpawn.mockReturnValue(createMockChild("result", "", 0) as ReturnType<typeof spawn>);

    await handleGrep({ pattern: "test", path: "src/lib" });

    expect(mockedSpawn).toHaveBeenCalledWith(
      "grep",
      ["-rn", "--color=never", "test", "src/lib"],
      expect.anything(),
    );
  });

  it("returns stdout verbatim for exit code 0", async () => {
    mockedSpawn.mockReturnValue(
      createMockChild("file.ts:10:match\nfile.ts:20:match2", "", 0) as ReturnType<typeof spawn>,
    );

    const result = await handleGrep({ pattern: "match" });
    expect(result.content[0].text).toBe("file.ts:10:match\nfile.ts:20:match2");
  });

  it('returns "(no matches found)" for exit code 1', async () => {
    mockedSpawn.mockReturnValue(createMockChild("", "", 1) as ReturnType<typeof spawn>);

    const result = await handleGrep({ pattern: "nonexistent" });
    expect(result.content[0].text).toBe("(no matches found)");
  });

  it('returns "Error: <stderr>" for exit code 2 with non-empty stderr', async () => {
    mockedSpawn.mockReturnValue(
      createMockChild("", "grep: invalid regex", 2) as ReturnType<typeof spawn>,
    );

    const result = await handleGrep({ pattern: "[invalid" });
    expect(result.content[0].text).toBe("Error: grep: invalid regex");
  });

  it("returns stdout for exit code 2 with empty stderr and non-empty stdout", async () => {
    mockedSpawn.mockReturnValue(
      createMockChild("some output", "", 2) as ReturnType<typeof spawn>,
    );

    const result = await handleGrep({ pattern: "something" });
    expect(result.content[0].text).toBe("some output");
  });

  it('returns "(no matches found)" for exit code 2 with empty stderr and empty stdout', async () => {
    mockedSpawn.mockReturnValue(createMockChild("", "", 2) as ReturnType<typeof spawn>);

    const result = await handleGrep({ pattern: "something" });
    expect(result.content[0].text).toBe("(no matches found)");
  });

  it('returns "Error executing grep: <message>" on spawn error', async () => {
    mockedSpawn.mockReturnValue(
      createSpawnErrorChild("spawn ENOENT") as ReturnType<typeof spawn>,
    );

    const result = await handleGrep({ pattern: "test" });
    expect(result.content[0].text).toBe("Error executing grep: spawn ENOENT");
  });

  it("does not set isError on the result", async () => {
    mockedSpawn.mockReturnValue(
      createSpawnErrorChild("spawn error") as ReturnType<typeof spawn>,
    );

    const result = await handleGrep({ pattern: "test" });
    expect("isError" in result).toBe(false);
  });

  it("result always has content with type text", async () => {
    mockedSpawn.mockReturnValue(createMockChild("output", "", 0) as ReturnType<typeof spawn>);

    const result = await handleGrep({ pattern: "test" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
  });

  it("attempts pruning when context_focus_question is truthy, stdout is non-empty, and exit code 0", async () => {
    mockedSpawn.mockReturnValue(
      createMockChild("big grep output", "", 0) as ReturnType<typeof spawn>,
    );
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
    });
    mockedPruneContent.mockResolvedValue("pruned grep output");

    const result = await handleGrep({
      pattern: "search",
      context_focus_question: "What matches?",
    });

    expect(mockedPruneContent).toHaveBeenCalledWith(
      "big grep output",
      "What matches?",
      expect.objectContaining({ enabled: true }),
    );
    expect(result.content[0].text).toBe("pruned grep output");
  });

  it('does NOT prune "(no matches found)" (exit code 1)', async () => {
    mockedSpawn.mockReturnValue(createMockChild("", "", 1) as ReturnType<typeof spawn>);
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
    });

    const result = await handleGrep({
      pattern: "no-match",
      context_focus_question: "question",
    });

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("(no matches found)");
  });

  it("does NOT prune error strings (exit code 2 with stderr)", async () => {
    mockedSpawn.mockReturnValue(
      createMockChild("", "bad pattern", 2) as ReturnType<typeof spawn>,
    );
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
    });

    const result = await handleGrep({
      pattern: "[bad",
      context_focus_question: "question",
    });

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Error: bad pattern");
  });

  it("does NOT prune spawn error strings", async () => {
    mockedSpawn.mockReturnValue(
      createSpawnErrorChild("spawn failed") as ReturnType<typeof spawn>,
    );
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
    });

    const result = await handleGrep({
      pattern: "test",
      context_focus_question: "question",
    });

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Error executing grep: spawn failed");
  });

  it("skips pruning when context_focus_question is not provided", async () => {
    mockedSpawn.mockReturnValue(
      createMockChild("output", "", 0) as ReturnType<typeof spawn>,
    );

    await handleGrep({ pattern: "test" });
    expect(mockedPruneContent).not.toHaveBeenCalled();
  });
});
