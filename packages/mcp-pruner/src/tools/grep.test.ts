import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

import { handleGrep } from "./grep.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const originalEnv = { ...process.env };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
  process.env.MCP_PRUNER_CWD = tmpDir;
});

afterEach(async () => {
  process.env.MCP_PRUNER_CWD = originalEnv.MCP_PRUNER_CWD;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic grep behavior
// ---------------------------------------------------------------------------

describe("handleGrep", () => {
  it("returns matching lines (exit code 0) verbatim as stdout", async () => {
    await fs.writeFile(path.join(tmpDir, "file.txt"), "hello world\nfoo bar\nhello again\n", "utf-8");

    const result = await handleGrep({ pattern: "hello", path: "file.txt" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("hello world");
    expect(result.content[0].text).toContain("hello again");
  });

  it('returns "(no matches found)" for exit code 1 (no matches)', async () => {
    await fs.writeFile(path.join(tmpDir, "file.txt"), "hello world\n", "utf-8");

    const result = await handleGrep({ pattern: "zzz_no_match_zzz", path: "file.txt" });

    expect(result.content[0].text).toBe("(no matches found)");
  });

  it('defaults path to "." when not specified', async () => {
    await fs.writeFile(path.join(tmpDir, "afile.txt"), "find me here\n", "utf-8");

    // No path argument – should default to "."
    const result = await handleGrep({ pattern: "find me" });

    expect(result.content[0].text).toContain("find me here");
  });

  it('returns "Error: <stderr>" for exit code 2 with non-empty stderr', async () => {
    // Pass an invalid regex that makes grep exit with code 2
    const result = await handleGrep({ pattern: "[invalid", path: tmpDir });

    expect(result.content[0].text).toMatch(/^Error: /);
  });

  it("uses grep -rn --color=never for execution", async () => {
    // Verify line numbers are in the output (from -n flag)
    await fs.writeFile(path.join(tmpDir, "numbered.txt"), "line1\nfind_this\nline3\n", "utf-8");

    const result = await handleGrep({ pattern: "find_this", path: "numbered.txt" });

    // grep -rn on a single file outputs "2:find_this"
    expect(result.content[0].text).toContain("2:");
    expect(result.content[0].text).toContain("find_this");
  });

  it("never sets result.isError", async () => {
    // Test with a failing pattern (exit code 2)
    const result = await handleGrep({ pattern: "[invalid", path: tmpDir });
    expect(result).not.toHaveProperty("isError");

    // Test with no matches
    await fs.writeFile(path.join(tmpDir, "empty.txt"), "nothing\n", "utf-8");
    const result2 = await handleGrep({ pattern: "zzz_no_match_zzz", path: "empty.txt" });
    expect(result2).not.toHaveProperty("isError");
  });

  it("returns grep output with recursive search (-r)", async () => {
    const subDir = path.join(tmpDir, "sub");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "deep.txt"), "deep content\n", "utf-8");

    const result = await handleGrep({ pattern: "deep content" });

    expect(result.content[0].text).toContain("deep content");
    expect(result.content[0].text).toContain("sub/deep.txt");
  });

  // ---------------------------------------------------------------------------
  // Pruning behavior
  // ---------------------------------------------------------------------------

  it("attempts pruning when context_focus_question is truthy and stdout is non-empty", async () => {
    await fs.writeFile(path.join(tmpDir, "match.txt"), "hello world\n", "utf-8");

    const prunerMod = await import("../pruner.js");
    const configSpy = vi.spyOn(prunerMod, "getPrunerConfig").mockReturnValue({
      url: "http://localhost:8000/prune",
      timeoutMs: 30_000,
      enabled: true,
    });
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent").mockResolvedValueOnce("pruned grep output");

    const result = await handleGrep({ pattern: "hello", path: "match.txt", context_focus_question: "what?" });

    expect(pruneSpy).toHaveBeenCalled();
    expect(result.content[0].text).toBe("pruned grep output");

    pruneSpy.mockRestore();
    configSpy.mockRestore();
  });

  it('does NOT prune "(no matches found)" result', async () => {
    await fs.writeFile(path.join(tmpDir, "nomatch.txt"), "abc\n", "utf-8");

    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    const result = await handleGrep({ pattern: "zzz", path: "nomatch.txt", context_focus_question: "focus?" });

    expect(result.content[0].text).toBe("(no matches found)");
    expect(pruneSpy).not.toHaveBeenCalled();

    pruneSpy.mockRestore();
  });

  it("does NOT prune error strings", async () => {
    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    const result = await handleGrep({ pattern: "[invalid", path: tmpDir, context_focus_question: "focus?" });

    expect(result.content[0].text).toMatch(/^Error: /);
    expect(pruneSpy).not.toHaveBeenCalled();

    pruneSpy.mockRestore();
  });

  it("does NOT prune when context_focus_question is absent", async () => {
    await fs.writeFile(path.join(tmpDir, "match2.txt"), "hello world\n", "utf-8");

    const prunerMod = await import("../pruner.js");
    const pruneSpy = vi.spyOn(prunerMod, "pruneContent");

    await handleGrep({ pattern: "hello", path: "match2.txt" });

    expect(pruneSpy).not.toHaveBeenCalled();
    pruneSpy.mockRestore();
  });
});
