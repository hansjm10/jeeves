import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { handleRead, readInputSchema } from "./read.js";
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("readInputSchema", () => {
  it("has a required file_path string field", () => {
    expect(readInputSchema.file_path).toBeDefined();
    // Zod shape: parsing with a valid value succeeds
    const result = readInputSchema.file_path.safeParse("/some/path");
    expect(result.success).toBe(true);
  });

  it("has an optional context_focus_question string field", () => {
    expect(readInputSchema.context_focus_question).toBeDefined();
    const resultPresent = readInputSchema.context_focus_question.safeParse("q");
    expect(resultPresent.success).toBe(true);
    const resultAbsent = readInputSchema.context_focus_question.safeParse(undefined);
    expect(resultAbsent.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleRead – file reading
// ---------------------------------------------------------------------------

describe("handleRead", () => {
  it("reads an absolute file path as-is", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    await fs.writeFile(filePath, "hello world", "utf-8");

    const result = await handleRead(
      { file_path: filePath },
      { cwd: "/should-not-matter", prunerConfig: disabledConfig() },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "hello world" }],
    });
  });

  it("resolves a relative file path against MCP_PRUNER_CWD", async () => {
    const filePath = path.join(tmpDir, "rel.txt");
    await fs.writeFile(filePath, "relative content", "utf-8");

    const result = await handleRead(
      { file_path: "rel.txt" },
      { cwd: tmpDir, prunerConfig: disabledConfig() },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "relative content" }],
    });
  });

  it("returns error text for a missing file", async () => {
    const result = await handleRead(
      { file_path: path.join(tmpDir, "does-not-exist.txt") },
      { cwd: tmpDir, prunerConfig: disabledConfig() },
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/^Error reading file: /);
  });

  it("does NOT set result.isError on file read failure", async () => {
    const result = await handleRead(
      { file_path: path.join(tmpDir, "nope.txt") },
      { cwd: tmpDir, prunerConfig: disabledConfig() },
    );

    // The result type is { content: [...] } – no isError field
    expect(result).not.toHaveProperty("isError");
  });

  it("reads empty files successfully", async () => {
    const filePath = path.join(tmpDir, "empty.txt");
    await fs.writeFile(filePath, "", "utf-8");

    const result = await handleRead(
      { file_path: filePath },
      { cwd: tmpDir, prunerConfig: disabledConfig() },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "" }],
    });
  });

  // ---------------------------------------------------------------------------
  // Pruning behavior
  // ---------------------------------------------------------------------------

  it("attempts pruning when context_focus_question is truthy and pruning is enabled", async () => {
    const filePath = path.join(tmpDir, "prune-me.txt");
    await fs.writeFile(filePath, "lots of code here", "utf-8");

    // Mock pruneContent via the pruner module
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent").mockResolvedValueOnce("pruned output");

    const result = await handleRead(
      { file_path: filePath, context_focus_question: "what does this do?" },
      { cwd: tmpDir, prunerConfig: enabledConfig() },
    );

    expect(pruneSpy).toHaveBeenCalledWith(
      "lots of code here",
      "what does this do?",
      enabledConfig(),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "pruned output" }],
    });

    pruneSpy.mockRestore();
  });

  it("does NOT attempt pruning when context_focus_question is absent", async () => {
    const filePath = path.join(tmpDir, "no-prune.txt");
    await fs.writeFile(filePath, "some content", "utf-8");

    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    await handleRead(
      { file_path: filePath },
      { cwd: tmpDir, prunerConfig: enabledConfig() },
    );

    expect(pruneSpy).not.toHaveBeenCalled();
    pruneSpy.mockRestore();
  });

  it("does NOT attempt pruning when pruning is disabled", async () => {
    const filePath = path.join(tmpDir, "disabled.txt");
    await fs.writeFile(filePath, "some content", "utf-8");

    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    await handleRead(
      { file_path: filePath, context_focus_question: "focus?" },
      { cwd: tmpDir, prunerConfig: disabledConfig() },
    );

    expect(pruneSpy).not.toHaveBeenCalled();
    pruneSpy.mockRestore();
  });

  it("does NOT prune error strings (returns early before pruning)", async () => {
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    const result = await handleRead(
      { file_path: path.join(tmpDir, "missing.txt"), context_focus_question: "focus?" },
      { cwd: tmpDir, prunerConfig: enabledConfig() },
    );

    expect(result.content[0].text).toMatch(/^Error reading file: /);
    expect(pruneSpy).not.toHaveBeenCalled();
    pruneSpy.mockRestore();
  });

  it("falls back to unpruned output when pruner fails", async () => {
    const filePath = path.join(tmpDir, "fallback.txt");
    await fs.writeFile(filePath, "raw content", "utf-8");

    const prunerMod = await import("../pruner.js");
    // pruneContent is designed to return original content on failure (never throws)
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent").mockResolvedValueOnce("raw content");

    const result = await handleRead(
      { file_path: filePath, context_focus_question: "focus?" },
      { cwd: tmpDir, prunerConfig: enabledConfig() },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "raw content" }],
    });

    pruneSpy.mockRestore();
  });

  it("attempts pruning even for empty file contents", async () => {
    const filePath = path.join(tmpDir, "empty-prune.txt");
    await fs.writeFile(filePath, "", "utf-8");

    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent").mockResolvedValueOnce("pruned empty");

    const result = await handleRead(
      { file_path: filePath, context_focus_question: "anything?" },
      { cwd: tmpDir, prunerConfig: enabledConfig() },
    );

    expect(pruneSpy).toHaveBeenCalledWith("", "anything?", enabledConfig());
    expect(result).toEqual({
      content: [{ type: "text", text: "pruned empty" }],
    });

    pruneSpy.mockRestore();
  });
});
