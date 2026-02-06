import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { handleGrep } from "./grep.js";

// ---------------------------------------------------------------------------
// handleGrep
// ---------------------------------------------------------------------------

describe("handleGrep", () => {
  const fixtureDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
  );

  // ------ exit code 0 (matches found) ------

  it("returns stdout verbatim when grep finds matches (exit 0)", async () => {
    // Search for a known string in this test file
    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      const result = await handleGrep({
        pattern: "handleGrep",
        path: "grep.test.ts",
      });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("handleGrep");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
    }
  });

  // ------ exit code 1 (no matches) ------

  it('returns "(no matches found)" when grep finds no matches (exit 1)', async () => {
    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      // Search in read.ts (which does not contain this unique string)
      const result = await handleGrep({
        pattern: "xyzzy_unique_nonexistent_42",
        path: "read.ts",
      });
      expect(result.content[0].text).toBe("(no matches found)");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
    }
  });

  // ------ exit code 2 with stderr ------

  it('returns "Error: <stderr>" when grep exit code 2 with non-empty stderr', async () => {
    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      // Search in a non-existent directory to trigger exit code 2 with stderr
      const result = await handleGrep({
        pattern: "anything",
        path: "/nonexistent/dir/for/grep/test",
      });
      expect(result.content[0].text).toMatch(/^Error: /);
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
    }
  });

  // ------ default path ------

  it("defaults path to '.' when not provided", async () => {
    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      const result = await handleGrep({
        pattern: "handleGrep",
      });
      // Should find the pattern in at least grep.ts and grep.test.ts
      expect(result.content[0].text).toContain("handleGrep");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
    }
  });

  // ------ result shape ------

  it("returns { content: [{ type: 'text', text }] } and never sets isError", async () => {
    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      const result = await handleGrep({
        pattern: "handleGrep",
        path: "grep.test.ts",
      });
      expect(result).toHaveProperty("content");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toHaveProperty("type", "text");
      expect(result.content[0]).toHaveProperty("text");
      expect(result).not.toHaveProperty("isError");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
    }
  });

  // ------ pruning behavior ------

  it("does not prune when context_focus_question is absent", async () => {
    const prunerMod = await import("../pruner.js");
    const spy = vi.spyOn(prunerMod, "pruneContent");
    spy.mockResolvedValueOnce("pruned");

    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      const result = await handleGrep({
        pattern: "handleGrep",
        path: "grep.test.ts",
      });
      expect(spy).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("handleGrep");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
      spy.mockRestore();
    }
  });

  it('does not prune "(no matches found)" even when context_focus_question is provided', async () => {
    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      // Search in read.ts for a pattern that doesn't exist there
      const result = await handleGrep({
        pattern: "xyzzy_unique_nonexistent_42",
        path: "read.ts",
        context_focus_question: "What is this?",
      });
      // exit code 1 = no matches -> isPruneable is false, so pruning is never attempted
      expect(result.content[0].text).toBe("(no matches found)");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
    }
  });

  it("attempts pruning when context_focus_question is truthy and matches found", async () => {
    const prunerMod = await import("../pruner.js");
    const spy = vi.spyOn(prunerMod, "pruneContent");
    spy.mockResolvedValueOnce("pruned result");

    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      const result = await handleGrep({
        pattern: "handleGrep",
        path: "grep.test.ts",
        context_focus_question: "What functions are exported?",
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("handleGrep"),
        "What functions are exported?",
        expect.any(Object),
      );
      expect(result.content[0].text).toBe("pruned result");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
      spy.mockRestore();
    }
  });

  // ------ error output format ------

  it("returns error text in content and does not set isError for exit code 2", async () => {
    const saved = process.env.MCP_PRUNER_CWD;
    process.env.MCP_PRUNER_CWD = fixtureDir;
    try {
      // Trigger exit code 2 with non-empty stderr by searching a non-existent path
      const result = await handleGrep({
        pattern: "test",
        path: "/nonexistent/dir/for/grep/test",
      });
      // Should return Error: <stderr> format
      expect(result.content[0].text).toMatch(/^Error: /);
      expect(result).not.toHaveProperty("isError");
    } finally {
      if (saved !== undefined) process.env.MCP_PRUNER_CWD = saved;
      else delete process.env.MCP_PRUNER_CWD;
    }
  });
});
