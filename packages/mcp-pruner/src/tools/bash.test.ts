import { describe, expect, it, vi } from "vitest";

import { handleBash } from "./bash.js";
import type { PrunerConfig } from "../pruner.js";

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
// Output formatting
// ---------------------------------------------------------------------------

describe("handleBash", () => {
  it("returns stdout for a successful command", async () => {
    const result = await handleBash(
      { command: 'echo "hello"' },
      cwd,
      disabledConfig(),
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text.trim()).toBe("hello");
  });

  it("appends stderr marker when stderr is non-empty", async () => {
    const result = await handleBash(
      { command: 'echo out && echo err >&2' },
      cwd,
      disabledConfig(),
    );

    const text = result.content[0].text;
    expect(text).toContain("out");
    expect(text).toContain("\n[stderr]\n");
    expect(text).toContain("err");
  });

  it("appends exit code marker when exit code is non-zero", async () => {
    const result = await handleBash(
      { command: "exit 42" },
      cwd,
      disabledConfig(),
    );

    const text = result.content[0].text;
    expect(text).toContain("[exit code: 42]");
  });

  it('returns "(no output)" when command produces no output and exits 0', async () => {
    const result = await handleBash(
      { command: "true" },
      cwd,
      disabledConfig(),
    );

    expect(result.content[0].text).toBe("(no output)");
  });

  it("includes both stderr and exit code markers for a failing command with stderr", async () => {
    const result = await handleBash(
      { command: 'echo err >&2; exit 1' },
      cwd,
      disabledConfig(),
    );

    const text = result.content[0].text;
    expect(text).toContain("\n[stderr]\n");
    expect(text).toContain("err");
    expect(text).toContain("\n[exit code: 1]");
  });

  it("never sets result.isError", async () => {
    const result = await handleBash(
      { command: "false" },
      cwd,
      disabledConfig(),
    );

    expect(result).not.toHaveProperty("isError");
  });

  // ---------------------------------------------------------------------------
  // Spawn errors
  // ---------------------------------------------------------------------------

  it('returns "Error executing command: <message>" on spawn failure', async () => {
    // Trigger a spawn error by using a non-existent cwd directory
    const result = await handleBash(
      { command: "echo hello" },
      "/tmp/this-directory-definitely-does-not-exist-12345",
      disabledConfig(),
    );

    expect(result.content[0].text).toMatch(/^Error executing command: /);
    expect(result).not.toHaveProperty("isError");
  });

  // ---------------------------------------------------------------------------
  // Pruning behavior
  // ---------------------------------------------------------------------------

  it("attempts pruning when context_focus_question is truthy and pruning enabled", async () => {
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent").mockResolvedValueOnce("pruned result");

    const result = await handleBash(
      { command: 'echo "hello"', context_focus_question: "what is this?" },
      cwd,
      enabledConfig(),
    );

    expect(pruneSpy).toHaveBeenCalled();
    expect(result.content[0].text).toBe("pruned result");

    pruneSpy.mockRestore();
  });

  it('does NOT prune "(no output)" placeholder', async () => {
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    const result = await handleBash(
      { command: "true", context_focus_question: "focus?" },
      cwd,
      enabledConfig(),
    );

    expect(result.content[0].text).toBe("(no output)");
    expect(pruneSpy).not.toHaveBeenCalled();

    pruneSpy.mockRestore();
  });

  it("does NOT prune spawn error strings", async () => {
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    // Trigger a spawn error with non-existent cwd
    const result = await handleBash(
      { command: "echo hello", context_focus_question: "focus?" },
      "/tmp/this-directory-definitely-does-not-exist-12345",
      enabledConfig(),
    );

    expect(result.content[0].text).toMatch(/^Error executing command: /);
    expect(pruneSpy).not.toHaveBeenCalled();

    pruneSpy.mockRestore();
  });

  it("does NOT attempt pruning when context_focus_question is absent", async () => {
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    await handleBash(
      { command: 'echo "hello"' },
      cwd,
      enabledConfig(),
    );

    expect(pruneSpy).not.toHaveBeenCalled();
    pruneSpy.mockRestore();
  });

  it("does NOT attempt pruning when pruning is disabled", async () => {
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    await handleBash(
      { command: 'echo "hello"', context_focus_question: "focus?" },
      cwd,
      disabledConfig(),
    );

    expect(pruneSpy).not.toHaveBeenCalled();
    pruneSpy.mockRestore();
  });
});
