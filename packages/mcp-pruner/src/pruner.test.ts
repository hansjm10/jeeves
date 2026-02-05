import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getPrunerConfig, pruneContent, type PrunerConfig } from "./pruner.js";

describe("getPrunerConfig", () => {
  it("returns default URL when PRUNER_URL is unset", () => {
    const config = getPrunerConfig({});
    expect(config.url).toBe("http://localhost:8000/prune");
    expect(config.enabled).toBe(true);
  });

  it("uses PRUNER_URL when set", () => {
    const config = getPrunerConfig({ PRUNER_URL: "http://custom:9000/api" });
    expect(config.url).toBe("http://custom:9000/api");
    expect(config.enabled).toBe(true);
  });

  it("disables pruning when PRUNER_URL is empty string", () => {
    const config = getPrunerConfig({ PRUNER_URL: "" });
    expect(config.url).toBe("");
    expect(config.enabled).toBe(false);
  });

  it("returns default timeout when PRUNER_TIMEOUT_MS is unset", () => {
    const config = getPrunerConfig({});
    expect(config.timeoutMs).toBe(30000);
  });

  it("parses valid PRUNER_TIMEOUT_MS", () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "5000" });
    expect(config.timeoutMs).toBe(5000);
  });

  it("clamps PRUNER_TIMEOUT_MS below minimum to 100", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "50" });
    expect(config.timeoutMs).toBe(100);
    stderrSpy.mockRestore();
  });

  it("clamps PRUNER_TIMEOUT_MS above maximum to 300000", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "500000" });
    expect(config.timeoutMs).toBe(300000);
    stderrSpy.mockRestore();
  });

  it("uses default timeout for invalid (NaN) PRUNER_TIMEOUT_MS", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "not-a-number" });
    expect(config.timeoutMs).toBe(30000);
    stderrSpy.mockRestore();
  });

  it("ignores empty string PRUNER_TIMEOUT_MS and uses default", () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "" });
    expect(config.timeoutMs).toBe(30000);
  });
});

describe("pruneContent", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeConfig(overrides: Partial<PrunerConfig> = {}): PrunerConfig {
    return {
      url: "http://localhost:8000/prune",
      timeoutMs: 30000,
      enabled: true,
      ...overrides,
    };
  }

  it("returns original content when pruning is disabled", async () => {
    const result = await pruneContent("original", "query", makeConfig({ enabled: false }));
    expect(result).toBe("original");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends POST { code, query } to the configured URL", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ pruned_code: "pruned" }),
    });

    await pruneContent("my code", "my query", makeConfig());

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8000/prune",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "my code", query: "my query" }),
      }),
    );
  });

  it("accepts pruned_code from the response", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ pruned_code: "pruned via pruned_code" }),
    });

    const result = await pruneContent("code", "query", makeConfig());
    expect(result).toBe("pruned via pruned_code");
  });

  it("accepts content from the response", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ content: "pruned via content" }),
    });

    const result = await pruneContent("code", "query", makeConfig());
    expect(result).toBe("pruned via content");
  });

  it("accepts text from the response", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "pruned via text" }),
    });

    const result = await pruneContent("code", "query", makeConfig());
    expect(result).toBe("pruned via text");
  });

  it("prefers pruned_code over content over text", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ pruned_code: "first", content: "second", text: "third" }),
    });

    const result = await pruneContent("code", "query", makeConfig());
    expect(result).toBe("first");
  });

  it("returns original content on non-2xx response (fallback)", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await pruneContent("original", "query", makeConfig());
    expect(result).toBe("original");
  });

  it("returns original content on network error (fallback)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await pruneContent("original", "query", makeConfig());
    expect(result).toBe("original");
  });

  it("returns original content on invalid JSON response (fallback)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("invalid json");
      },
    });

    const result = await pruneContent("original", "query", makeConfig());
    expect(result).toBe("original");
  });

  it("returns original content when response is not a JSON object (fallback)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => "a string",
    });

    const result = await pruneContent("original", "query", makeConfig());
    expect(result).toBe("original");
  });

  it("returns original content when response is null (fallback)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => null,
    });

    const result = await pruneContent("original", "query", makeConfig());
    expect(result).toBe("original");
  });

  it("returns original content when response has no pruned_code/content/text fields (fallback)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ other_field: "value" }),
    });

    const result = await pruneContent("original", "query", makeConfig());
    expect(result).toBe("original");
  });

  it("returns original content on timeout (abort signal)", async () => {
    fetchSpy.mockRejectedValue(new DOMException("Aborted", "AbortError"));

    const result = await pruneContent("original", "query", makeConfig());
    expect(result).toBe("original");
  });

  it("never throws on any failure", async () => {
    fetchSpy.mockRejectedValue(new Error("total failure"));

    // Should not throw
    const result = await pruneContent("safe", "query", makeConfig());
    expect(result).toBe("safe");
  });
});
