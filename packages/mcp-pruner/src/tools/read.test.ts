import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { PrunerConfig } from "../pruner.js";
import { handleRead, readInputSchema } from "./read.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function disabledConfig(): PrunerConfig {
  return { url: "", timeoutMs: 30_000, enabled: false };
}

function enabledConfig(): PrunerConfig {
  return { url: "http://localhost:8000/prune", timeoutMs: 30_000, enabled: true };
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

describe("readInputSchema", () => {
  it("has required file_path and optional context_focus_question", () => {
    expect(readInputSchema.file_path).toBeDefined();
    expect(readInputSchema.context_focus_question).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// handleRead
// ---------------------------------------------------------------------------

describe("handleRead", () => {
  const cwd = process.cwd();

  // ------ path resolution ------

  it("reads an absolute file path as-is", async () => {
    // Use this test file itself as a known-existing absolute path.
    const absPath = path.resolve(__dirname, "read.test.ts");
    const result = await handleRead(
      { file_path: absPath },
      { cwd: "/tmp", prunerConfig: disabledConfig() },
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("handleRead");
  });

  it("resolves relative file_path against MCP_PRUNER_CWD", async () => {
    // Relative path from the mcp-pruner/src/tools directory to read.ts
    const result = await handleRead(
      { file_path: "read.ts" },
      { cwd: path.resolve(__dirname), prunerConfig: disabledConfig() },
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("handleRead");
  });

  // ------ error handling ------

  it('returns "Error reading file: <message>" for missing files without isError', async () => {
    const result = await handleRead(
      { file_path: "/nonexistent/file/path.txt" },
      { cwd, prunerConfig: disabledConfig() },
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/^Error reading file: /);
    // Must NOT set isError (result should only have content key)
    expect(Object.keys(result)).toEqual(["content"]);
  });

  // ------ success without pruning ------

  it("returns raw file contents when context_focus_question is absent", async () => {
    const absPath = path.resolve(__dirname, "read.ts");
    const result = await handleRead(
      { file_path: absPath },
      { cwd, prunerConfig: enabledConfig() },
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("handleRead");
    expect(Object.keys(result)).toEqual(["content"]);
  });

  it("returns raw file contents when pruning is disabled", async () => {
    const absPath = path.resolve(__dirname, "read.ts");
    const result = await handleRead(
      { file_path: absPath, context_focus_question: "What does handleRead do?" },
      { cwd, prunerConfig: disabledConfig() },
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("handleRead");
  });

  // ------ pruning fallback ------

  it("attempts pruning when context_focus_question is truthy and pruning enabled", async () => {
    // Mock pruneContent to verify it is called with correct args
    const pruneContentSpy = vi.spyOn(
      await import("../pruner.js"),
      "pruneContent",
    );
    pruneContentSpy.mockResolvedValueOnce("pruned result");

    const absPath = path.resolve(__dirname, "read.ts");
    const config = enabledConfig();
    const result = await handleRead(
      { file_path: absPath, context_focus_question: "What does this do?" },
      { cwd, prunerConfig: config },
    );

    expect(pruneContentSpy).toHaveBeenCalledWith(
      expect.any(String),
      "What does this do?",
      config,
    );
    expect(result.content[0].text).toBe("pruned result");

    pruneContentSpy.mockRestore();
  });

  // ------ result shape ------

  it("returns { content: [{ type: 'text', text }] } and never sets isError", async () => {
    const absPath = path.resolve(__dirname, "read.ts");
    const result = await handleRead(
      { file_path: absPath },
      { cwd, prunerConfig: disabledConfig() },
    );
    expect(result).toHaveProperty("content");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toHaveProperty("type", "text");
    expect(result.content[0]).toHaveProperty("text");
    expect(result).not.toHaveProperty("isError");
  });
});
