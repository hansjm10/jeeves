import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";
import { handleRead, readInputSchema } from "./read.js";
import type { PrunerConfig } from "../pruner.js";

// Mock fs/promises so we don't touch the real filesystem
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

// Mock the pruner module
vi.mock("../pruner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../pruner.js")>();
  return {
    ...original,
    pruneContent: vi.fn(),
  };
});

import { readFile } from "node:fs/promises";
import { pruneContent } from "../pruner.js";

const mockedReadFile = vi.mocked(readFile);
const mockedPruneContent = vi.mocked(pruneContent);

function makeConfig(overrides: Partial<PrunerConfig> = {}): PrunerConfig {
  return {
    url: "http://localhost:8000/prune",
    timeoutMs: 30000,
    enabled: true,
    ...overrides,
  };
}

function makeDeps(overrides: { cwd?: string; prunerConfig?: PrunerConfig } = {}) {
  return {
    cwd: overrides.cwd ?? "/workspace",
    prunerConfig: overrides.prunerConfig ?? makeConfig(),
  };
}

describe("readInputSchema", () => {
  it("has required file_path and optional context_focus_question", () => {
    expect(readInputSchema.file_path).toBeDefined();
    expect(readInputSchema.context_focus_question).toBeDefined();
  });
});

describe("handleRead", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads an absolute file path as-is", async () => {
    mockedReadFile.mockResolvedValue("file contents");
    const result = await handleRead(
      { file_path: "/absolute/path/to/file.ts" },
      makeDeps({ prunerConfig: makeConfig({ enabled: false }) }),
    );

    expect(mockedReadFile).toHaveBeenCalledWith("/absolute/path/to/file.ts", "utf-8");
    expect(result).toEqual({
      content: [{ type: "text", text: "file contents" }],
    });
  });

  it("resolves relative file_path against MCP_PRUNER_CWD", async () => {
    mockedReadFile.mockResolvedValue("relative contents");
    const result = await handleRead(
      { file_path: "src/foo.ts" },
      makeDeps({ cwd: "/my/project", prunerConfig: makeConfig({ enabled: false }) }),
    );

    const expectedPath = path.resolve("/my/project", "src/foo.ts");
    expect(mockedReadFile).toHaveBeenCalledWith(expectedPath, "utf-8");
    expect(result.content[0].text).toBe("relative contents");
  });

  it('returns "Error reading file: <message>" on read failure', async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT: no such file"));
    const result = await handleRead(
      { file_path: "/nonexistent" },
      makeDeps({ prunerConfig: makeConfig({ enabled: false }) }),
    );

    expect(result.content[0].text).toBe("Error reading file: ENOENT: no such file");
  });

  it("does not set isError on the result for read failures", async () => {
    mockedReadFile.mockRejectedValue(new Error("permission denied"));
    const result = await handleRead(
      { file_path: "/forbidden" },
      makeDeps({ prunerConfig: makeConfig({ enabled: false }) }),
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "Error reading file: permission denied" }],
    });
    // Verify no isError property
    expect("isError" in result).toBe(false);
  });

  it("attempts pruning when context_focus_question is truthy and pruning enabled", async () => {
    mockedReadFile.mockResolvedValue("raw file content");
    mockedPruneContent.mockResolvedValue("pruned content");

    const result = await handleRead(
      { file_path: "/file.ts", context_focus_question: "What does this do?" },
      makeDeps({ prunerConfig: makeConfig({ enabled: true }) }),
    );

    expect(mockedPruneContent).toHaveBeenCalledWith(
      "raw file content",
      "What does this do?",
      expect.objectContaining({ enabled: true }),
    );
    expect(result.content[0].text).toBe("pruned content");
  });

  it("passes context_focus_question verbatim to pruneContent", async () => {
    mockedReadFile.mockResolvedValue("content");
    mockedPruneContent.mockResolvedValue("pruned");

    await handleRead(
      { file_path: "/file.ts", context_focus_question: "  spaces included  " },
      makeDeps({ prunerConfig: makeConfig({ enabled: true }) }),
    );

    expect(mockedPruneContent).toHaveBeenCalledWith(
      "content",
      "  spaces included  ",
      expect.anything(),
    );
  });

  it("skips pruning when context_focus_question is not provided", async () => {
    mockedReadFile.mockResolvedValue("raw content");

    const result = await handleRead(
      { file_path: "/file.ts" },
      makeDeps({ prunerConfig: makeConfig({ enabled: true }) }),
    );

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("raw content");
  });

  it("skips pruning when pruner is disabled", async () => {
    mockedReadFile.mockResolvedValue("raw content");

    const result = await handleRead(
      { file_path: "/file.ts", context_focus_question: "question" },
      makeDeps({ prunerConfig: makeConfig({ enabled: false }) }),
    );

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("raw content");
  });

  it("attempts pruning even for empty file contents", async () => {
    mockedReadFile.mockResolvedValue("");
    mockedPruneContent.mockResolvedValue("pruned empty");

    const result = await handleRead(
      { file_path: "/empty.ts", context_focus_question: "question" },
      makeDeps({ prunerConfig: makeConfig({ enabled: true }) }),
    );

    expect(mockedPruneContent).toHaveBeenCalledWith("", "question", expect.anything());
    expect(result.content[0].text).toBe("pruned empty");
  });

  it("does NOT attempt pruning for file read error strings", async () => {
    mockedReadFile.mockRejectedValue(new Error("read error"));

    const result = await handleRead(
      { file_path: "/bad", context_focus_question: "question" },
      makeDeps({ prunerConfig: makeConfig({ enabled: true }) }),
    );

    expect(mockedPruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Error reading file: read error");
  });

  it("falls back to unpruned output when pruneContent returns original", async () => {
    mockedReadFile.mockResolvedValue("original content");
    // Simulate pruner failure by returning original content
    mockedPruneContent.mockResolvedValue("original content");

    const result = await handleRead(
      { file_path: "/file.ts", context_focus_question: "question" },
      makeDeps({ prunerConfig: makeConfig({ enabled: true }) }),
    );

    expect(result.content[0].text).toBe("original content");
  });
});
