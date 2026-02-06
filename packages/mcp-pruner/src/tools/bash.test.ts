import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleBash } from "./bash.js";
import type { PrunerConfig } from "../pruner.js";

// Mock the pruner module
vi.mock("../pruner.js", () => ({
  pruneContent: vi.fn(),
}));

import { pruneContent } from "../pruner.js";
const mockedPruneContent = vi.mocked(pruneContent);

const disabledConfig: PrunerConfig = {
  url: "",
  timeoutMs: 30000,
  enabled: false,
};

const enabledConfig: PrunerConfig = {
  url: "http://localhost:8000/prune",
  timeoutMs: 30000,
  enabled: true,
};

describe("handleBash", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ---- Output formatting (Section 3 exact markers) ----

  it("returns stdout on successful command (exit code 0)", async () => {
    const result = await handleBash(
      { command: 'echo "hello world"' },
      "/tmp",
      disabledConfig,
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("hello world");
  });

  it('returns "(no output)" when assembled output is empty', async () => {
    const result = await handleBash(
      { command: "true" },
      "/tmp",
      disabledConfig,
    );
    expect(result.content[0].text).toBe("(no output)");
  });

  it('appends "\\n[stderr]\\n<stderr>" when stderr is non-empty', async () => {
    const result = await handleBash(
      { command: 'echo err >&2' },
      "/tmp",
      disabledConfig,
    );
    expect(result.content[0].text).toContain("\n[stderr]\n");
    expect(result.content[0].text).toContain("err");
  });

  it('appends "\\n[exit code: <code>]" when exit code !== 0', async () => {
    const result = await handleBash(
      { command: "exit 42" },
      "/tmp",
      disabledConfig,
    );
    expect(result.content[0].text).toContain("\n[exit code: 42]");
  });

  it("includes both stderr and exit code when both present", async () => {
    const result = await handleBash(
      { command: 'echo err >&2; exit 1' },
      "/tmp",
      disabledConfig,
    );
    expect(result.content[0].text).toContain("\n[stderr]\n");
    expect(result.content[0].text).toContain("\n[exit code: 1]");
  });

  it("includes stdout + stderr + exit code together", async () => {
    const result = await handleBash(
      { command: 'echo out; echo err >&2; exit 2' },
      "/tmp",
      disabledConfig,
    );
    const text = result.content[0].text;
    expect(text).toContain("out");
    expect(text).toContain("\n[stderr]\n");
    expect(text).toContain("err");
    expect(text).toContain("\n[exit code: 2]");
  });

  // ---- Spawn error formatting (exact prefix from Section 3) ----

  it('returns "Error executing command: <message>" on spawn failure', async () => {
    // Use a command that will cause a spawn-like error
    // We'll invoke handleBash with a cwd that doesn't exist to trigger an error
    const result = await handleBash(
      { command: "echo hi" },
      "/absolutely/nonexistent/directory/that/does/not/exist",
      disabledConfig,
    );
    expect(result.content[0].text).toMatch(/^Error executing command: /);
  });

  it("does not set isError on spawn failures", async () => {
    const result = await handleBash(
      { command: "echo hi" },
      "/absolutely/nonexistent/directory/that/does/not/exist",
      disabledConfig,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringMatching(/^Error executing command: /) }],
    });
    expect("isError" in result).toBe(false);
  });

  // ---- result.isError is never set ----

  it("does not set isError on any result", async () => {
    const result = await handleBash(
      { command: "exit 1" },
      "/tmp",
      disabledConfig,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: expect.any(String) }],
    });
    expect("isError" in result).toBe(false);
  });

  // ---- Pruning behavior ----

  it("attempts pruning when context_focus_question is provided and pruning is enabled", async () => {
    mockedPruneContent.mockResolvedValue("pruned bash output");
    const result = await handleBash(
      { command: 'echo "hello"', context_focus_question: "What is this?" },
      "/tmp",
      enabledConfig,
    );
    expect(mockedPruneContent).toHaveBeenCalledWith(
      expect.stringContaining("hello"),
      "What is this?",
      enabledConfig,
    );
    expect(result.content[0].text).toBe("pruned bash output");
  });

  it('does not prune "(no output)" placeholder', async () => {
    const result = await handleBash(
      { command: "true", context_focus_question: "question" },
      "/tmp",
      enabledConfig,
    );
    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("(no output)");
  });

  it("does not prune spawn error output", async () => {
    const result = await handleBash(
      { command: "echo hi", context_focus_question: "question" },
      "/absolutely/nonexistent/directory",
      enabledConfig,
    );
    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/^Error executing command: /);
  });

  it("does not attempt pruning when context_focus_question is absent", async () => {
    await handleBash(
      { command: 'echo "hello"' },
      "/tmp",
      enabledConfig,
    );
    expect(mockedPruneContent).not.toHaveBeenCalled();
  });
});
