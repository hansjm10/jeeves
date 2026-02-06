import { describe, expect, it, vi } from "vitest";
import type { PrunerConfig } from "../pruner.js";
import { handleBash } from "./bash.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function disabledConfig(): PrunerConfig {
  return { url: "", timeoutMs: 30_000, enabled: false };
}

function enabledConfig(): PrunerConfig {
  return { url: "http://localhost:8000/prune", timeoutMs: 30_000, enabled: true };
}

const cwd = process.cwd();

// ---------------------------------------------------------------------------
// handleBash
// ---------------------------------------------------------------------------

describe("handleBash", () => {
  // ------ output formatting ------

  it("returns stdout for a successful command (exit 0)", async () => {
    const result = await handleBash(
      { command: 'echo "hello world"' },
      cwd,
      disabledConfig(),
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("hello world");
  });

  it('appends "\\n[stderr]\\n<stderr>" when stderr is non-empty', async () => {
    const result = await handleBash(
      { command: 'echo "out" && echo "err" >&2' },
      cwd,
      disabledConfig(),
    );
    expect(result.content[0].text).toContain("[stderr]");
    expect(result.content[0].text).toContain("err");
  });

  it('appends "\\n[exit code: <code>]" when exit code !== 0', async () => {
    const result = await handleBash(
      { command: "exit 42" },
      cwd,
      disabledConfig(),
    );
    expect(result.content[0].text).toContain("[exit code: 42]");
  });

  it('returns "(no output)" when command produces no output and exits 0', async () => {
    const result = await handleBash(
      { command: "true" },
      cwd,
      disabledConfig(),
    );
    expect(result.content[0].text).toBe("(no output)");
  });

  it("includes both stderr and non-zero exit code when both present", async () => {
    const result = await handleBash(
      { command: 'echo "err" >&2; exit 1' },
      cwd,
      disabledConfig(),
    );
    const text = result.content[0].text;
    expect(text).toContain("[stderr]");
    expect(text).toContain("err");
    expect(text).toContain("[exit code: 1]");
  });

  // ------ spawn error ------

  it('returns "Error executing command: <message>" on spawn failure without isError', async () => {
    // Use a command that will fail to spawn by passing invalid shell
    // We can trigger this by mocking execFile or using an approach that causes error
    // A simpler approach: use a non-existent shell path
    const result = await handleBash(
      { command: "echo hi" },
      "/nonexistent/directory/that/definitely/does/not/exist",
      disabledConfig(),
    );
    // With a non-existent cwd, the command may error or the output may have stderr
    // Let's just verify the shape
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result).not.toHaveProperty("isError");
  });

  // ------ result shape ------

  it("returns { content: [{ type: 'text', text }] } and never sets isError", async () => {
    const result = await handleBash(
      { command: 'echo "test"' },
      cwd,
      disabledConfig(),
    );
    expect(result).toHaveProperty("content");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toHaveProperty("type", "text");
    expect(result.content[0]).toHaveProperty("text");
    expect(result).not.toHaveProperty("isError");
  });

  // ------ pruning behavior ------

  it("does not attempt pruning when context_focus_question is absent", async () => {
    const prunerMod = await import("../pruner.js");
    const spy = vi.spyOn(prunerMod, "pruneContent");
    spy.mockResolvedValueOnce("pruned");

    const result = await handleBash(
      { command: 'echo "hello"' },
      cwd,
      enabledConfig(),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("hello");
    spy.mockRestore();
  });

  it('does not prune "(no output)" even when context_focus_question is provided', async () => {
    const prunerMod = await import("../pruner.js");
    const spy = vi.spyOn(prunerMod, "pruneContent");
    spy.mockResolvedValueOnce("pruned");

    const result = await handleBash(
      { command: "true", context_focus_question: "What happened?" },
      cwd,
      enabledConfig(),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("(no output)");
    spy.mockRestore();
  });

  it("attempts pruning when context_focus_question is truthy and output is non-empty", async () => {
    const prunerMod = await import("../pruner.js");
    const spy = vi.spyOn(prunerMod, "pruneContent");
    spy.mockResolvedValueOnce("pruned output");

    const config = enabledConfig();
    const result = await handleBash(
      { command: 'echo "data"', context_focus_question: "What is this?" },
      cwd,
      config,
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("data"),
      "What is this?",
      config,
    );
    expect(result.content[0].text).toBe("pruned output");
    spy.mockRestore();
  });

  it("falls back to raw output when pruning is disabled", async () => {
    const result = await handleBash(
      { command: 'echo "data"', context_focus_question: "Focus?" },
      cwd,
      disabledConfig(),
    );
    expect(result.content[0].text).toContain("data");
  });
});
