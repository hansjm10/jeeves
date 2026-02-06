import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// We need to mock child_process.spawn at module level for ESM compatibility
const mockSpawnFn = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawnFn(...args),
  };
});

// Mock the pruner module
vi.mock("../pruner.js", () => ({
  getPrunerConfig: vi.fn(() => ({
    url: "",
    timeoutMs: 30000,
    enabled: false,
  })),
  pruneContent: vi.fn(),
}));

import { handleGrep } from "./grep.js";
import { getPrunerConfig, pruneContent } from "../pruner.js";

const mockedGetPrunerConfig = vi.mocked(getPrunerConfig);
const mockedPruneContent = vi.mocked(pruneContent);

function makeChildMock(opts: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
  spawnError?: Error;
}): EventEmitter & { stdout: Readable; stderr: Readable } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = new EventEmitter() as any;
  const stdoutStream = new Readable({ read() { /* noop */ } });
  const stderrStream = new Readable({ read() { /* noop */ } });
  child.stdout = stdoutStream;
  child.stderr = stderrStream;

  process.nextTick(() => {
    if (opts.spawnError) {
      child.emit("error", opts.spawnError);
      return;
    }
    if (opts.stdout) stdoutStream.push(opts.stdout);
    stdoutStream.push(null);
    if (opts.stderr) stderrStream.push(opts.stderr);
    stderrStream.push(null);
    // Emit close after a tick to allow stream data events to fire
    setTimeout(() => {
      child.emit("close", opts.exitCode);
    }, 0);
  });

  return child;
}

describe("handleGrep", () => {
  beforeEach(() => {
    mockSpawnFn.mockReset();
    mockedGetPrunerConfig.mockReturnValue({
      url: "",
      timeoutMs: 30000,
      enabled: false,
    });
    mockedPruneContent.mockReset();
    process.env.MCP_PRUNER_CWD = "/tmp";
  });

  afterEach(() => {
    delete process.env.MCP_PRUNER_CWD;
  });

  // ---- Exit code 0: matches found ----

  it("returns stdout verbatim when grep finds matches (exit code 0)", async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({ stdout: "/etc/passwd:1:root:x:0:0:root\n", stderr: "", exitCode: 0 }),
    );
    const result = await handleGrep({ pattern: "root", path: "/etc/passwd" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("root");
  });

  // ---- Exit code 1: no matches ----

  it('returns "(no matches found)" when grep finds no matches (exit code 1)', async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({ stdout: "", stderr: "", exitCode: 1 }),
    );
    const result = await handleGrep({
      pattern: "xyzzy_definitely_not_found_12345",
      path: "/etc/hostname",
    });
    expect(result.content[0].text).toBe("(no matches found)");
  });

  // ---- Exit code 2: with non-empty stderr → "Error: <stderr>" ----

  it('returns "Error: <stderr>" when exit code 2 and stderr is non-empty', async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({
        stdout: "",
        stderr: "grep: /nonexistent: No such file or directory\n",
        exitCode: 2,
      }),
    );
    const result = await handleGrep({
      pattern: "test",
      path: "/nonexistent",
    });
    expect(result.content[0].text).toMatch(/^Error: /);
    expect(result.content[0].text).toContain("No such file or directory");
  });

  // ---- Exit code 2: with empty stderr → stdout or "(no matches found)" ----
  // (Branch documented at docs/issue-98-design.md:224)

  it("returns stdout when exit code 2 but stderr is empty and stdout is non-empty", async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({
        stdout: "some output line\n",
        stderr: "",
        exitCode: 2,
      }),
    );
    const result = await handleGrep({ pattern: "test", path: "." });
    // Exit code 2, empty stderr, non-empty stdout → return stdout
    expect(result.content[0].text).toBe("some output line\n");
    expect(result.content[0].text).not.toMatch(/^Error: /);
  });

  it('returns "(no matches found)" when exit code 2, stderr is empty, and stdout is empty', async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({
        stdout: "",
        stderr: "",
        exitCode: 2,
      }),
    );
    const result = await handleGrep({ pattern: "test", path: "." });
    // Exit code 2, empty stderr, empty stdout → "(no matches found)"
    expect(result.content[0].text).toBe("(no matches found)");
  });

  // ---- Spawn error (exact prefix from docs/issue-98-design.md:225) ----

  it('returns "Error executing grep: <message>" on spawn failure', async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({ spawnError: new Error("spawn ENOENT"), exitCode: -1 }),
    );
    const result = await handleGrep({ pattern: "test", path: "." });
    expect(result.content[0].text).toBe("Error executing grep: spawn ENOENT");
  });

  // ---- result.isError is never set ----

  it("does not set isError on any result", async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({ stdout: "", stderr: "", exitCode: 1 }),
    );
    const result = await handleGrep({
      pattern: "xyzzy_not_found",
      path: "/etc/hostname",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "(no matches found)" }],
    });
    expect("isError" in result).toBe(false);
  });

  it("does not set isError on error results", async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({
        stdout: "",
        stderr: "grep: error\n",
        exitCode: 2,
      }),
    );
    const result = await handleGrep({
      pattern: "test",
      path: "/nonexistent",
    });
    expect("isError" in result).toBe(false);
  });

  // ---- Default path ----

  it('defaults path to "." when not provided', async () => {
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({ stdout: "", stderr: "", exitCode: 1 }),
    );
    const result = await handleGrep({ pattern: "xyzzy_definitely_not_found" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // Verify spawn was called with "." as the path argument
    expect(mockSpawnFn).toHaveBeenCalledWith(
      "grep",
      ["-rn", "--color=never", "xyzzy_definitely_not_found", "."],
      expect.any(Object),
    );
  });

  // ---- Pruning behavior ----

  it("attempts pruning when context_focus_question is provided and stdout is non-empty", async () => {
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
    });
    mockedPruneContent.mockResolvedValue("pruned grep output");
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({ stdout: "match:1:line\n", stderr: "", exitCode: 0 }),
    );

    const result = await handleGrep({
      pattern: "match",
      path: "/some/path",
      context_focus_question: "What users exist?",
    });
    expect(mockedPruneContent).toHaveBeenCalled();
    expect(result.content[0].text).toBe("pruned grep output");
  });

  it('does not prune "(no matches found)" output', async () => {
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
    });
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({ stdout: "", stderr: "", exitCode: 1 }),
    );

    const result = await handleGrep({
      pattern: "xyzzy_not_found_12345",
      path: "/etc/hostname",
      context_focus_question: "question",
    });
    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("(no matches found)");
  });

  it("does not prune error strings", async () => {
    mockedGetPrunerConfig.mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
    });
    mockSpawnFn.mockReturnValueOnce(
      makeChildMock({
        stdout: "",
        stderr: "grep: error\n",
        exitCode: 2,
      }),
    );

    const result = await handleGrep({
      pattern: "test",
      path: "/nonexistent",
      context_focus_question: "question",
    });
    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/^Error: /);
  });
});
