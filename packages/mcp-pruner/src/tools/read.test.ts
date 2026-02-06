import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleRead, type ReadToolDeps } from "./read.js";
import type { PrunerConfig } from "../pruner.js";

// Mock the pruner module to control pruneContent behavior
vi.mock("../pruner.js", () => ({
  pruneContent: vi.fn(),
}));

import { pruneContent } from "../pruner.js";
const mockedPruneContent = vi.mocked(pruneContent);

function makeDeps(overrides?: Partial<ReadToolDeps>): ReadToolDeps {
  return {
    cwd: "/test/cwd",
    prunerConfig: { url: "", timeoutMs: 30000, enabled: false },
    ...overrides,
  };
}

function enabledConfig(): PrunerConfig {
  return { url: "http://localhost:8000/prune", timeoutMs: 30000, enabled: true };
}

describe("handleRead", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ---- Input schema / path resolution ----

  it("resolves absolute file_path as-is", async () => {
    // Use a known file that exists
    const result = await handleRead(
      { file_path: "/dev/null" },
      makeDeps(),
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // /dev/null returns empty string
    expect(result.content[0].text).toBe("");
  });

  it("resolves relative file_path against MCP_PRUNER_CWD", async () => {
    // Reading a relative path should resolve against cwd
    // This will fail to read since /test/cwd/nonexistent doesn't exist
    const result = await handleRead(
      { file_path: "nonexistent.txt" },
      makeDeps({ cwd: "/test/cwd" }),
    );
    expect(result.content[0].text).toMatch(/^Error reading file: /);
  });

  // ---- Read failure formatting ----

  it('returns "Error reading file: <message>" on ENOENT', async () => {
    const result = await handleRead(
      { file_path: "/absolutely/does/not/exist/file.txt" },
      makeDeps(),
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/^Error reading file: /);
    expect(result.content[0].text).toContain("ENOENT");
  });

  it("does not set isError on read failures", async () => {
    const result = await handleRead(
      { file_path: "/absolutely/does/not/exist/file.txt" },
      makeDeps(),
    );
    // Result should only have content, no isError property
    expect(result).toEqual({
      content: [{ type: "text", text: expect.stringMatching(/^Error reading file: /) }],
    });
    expect("isError" in result).toBe(false);
  });

  // ---- Success: returns raw file content ----

  it("returns file contents on success without pruning when no context_focus_question", async () => {
    const result = await handleRead(
      { file_path: "/dev/null" },
      makeDeps(),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "" }],
    });
    expect(mockedPruneContent).not.toHaveBeenCalled();
  });

  // ---- Pruning behavior ----

  it("attempts pruning when context_focus_question is provided and pruning is enabled", async () => {
    mockedPruneContent.mockResolvedValue("pruned output");
    const result = await handleRead(
      { file_path: "/dev/null", context_focus_question: "What does this do?" },
      makeDeps({ prunerConfig: enabledConfig() }),
    );
    expect(mockedPruneContent).toHaveBeenCalledWith(
      "",
      "What does this do?",
      enabledConfig(),
    );
    expect(result.content[0].text).toBe("pruned output");
  });

  it("does not attempt pruning when context_focus_question is provided but pruning is disabled", async () => {
    const result = await handleRead(
      { file_path: "/dev/null", context_focus_question: "question" },
      makeDeps({ prunerConfig: { url: "", timeoutMs: 30000, enabled: false } }),
    );
    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("");
  });

  it("does not attempt pruning for file-read error string", async () => {
    const result = await handleRead(
      { file_path: "/does/not/exist", context_focus_question: "question" },
      makeDeps({ prunerConfig: enabledConfig() }),
    );
    // Pruning is NOT attempted for the error string (returned early)
    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/^Error reading file: /);
  });

  it("attempts pruning even for empty file contents", async () => {
    mockedPruneContent.mockResolvedValue("");
    const result = await handleRead(
      { file_path: "/dev/null", context_focus_question: "question" },
      makeDeps({ prunerConfig: enabledConfig() }),
    );
    // Pruning is eligible even for empty file contents ("")
    expect(mockedPruneContent).toHaveBeenCalledWith("", "question", enabledConfig());
    expect(result.content[0].text).toBe("");
  });

  it("falls back to unpruned output when pruner fails", async () => {
    // pruneContent returns original content on failure (by contract)
    mockedPruneContent.mockResolvedValue("original file content");
    const result = await handleRead(
      { file_path: "/dev/null", context_focus_question: "question" },
      makeDeps({ prunerConfig: enabledConfig() }),
    );
    expect(result.content[0].text).toBe("original file content");
  });

  it("passes context_focus_question verbatim to pruneContent", async () => {
    mockedPruneContent.mockResolvedValue("pruned");
    await handleRead(
      { file_path: "/dev/null", context_focus_question: "  spaces and stuff  " },
      makeDeps({ prunerConfig: enabledConfig() }),
    );
    expect(mockedPruneContent).toHaveBeenCalledWith(
      "",
      "  spaces and stuff  ",
      enabledConfig(),
    );
  });
});
