import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getPrunerConfig, pruneContent, type PrunerConfig } from "./pruner.js";

describe("getPrunerConfig", () => {
  it("returns default URL and timeout when no env vars set", () => {
    const config = getPrunerConfig({});
    expect(config.url).toBe("http://localhost:8000/prune");
    expect(config.timeoutMs).toBe(30000);
    expect(config.enabled).toBe(true);
  });

  it("uses PRUNER_URL when provided", () => {
    const config = getPrunerConfig({ PRUNER_URL: "http://custom:9000/prune" });
    expect(config.url).toBe("http://custom:9000/prune");
    expect(config.enabled).toBe(true);
  });

  it("disables pruning when PRUNER_URL is empty string", () => {
    const config = getPrunerConfig({ PRUNER_URL: "" });
    expect(config.url).toBe("");
    expect(config.enabled).toBe(false);
  });

  it("uses default timeout when PRUNER_TIMEOUT_MS is not set", () => {
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
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "999999" });
    expect(config.timeoutMs).toBe(300000);
    stderrSpy.mockRestore();
  });

  it("uses default timeout for NaN PRUNER_TIMEOUT_MS", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "not_a_number" });
    expect(config.timeoutMs).toBe(30000);
    stderrSpy.mockRestore();
  });

  it("ignores empty string PRUNER_TIMEOUT_MS", () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "" });
    expect(config.timeoutMs).toBe(30000);
  });
});

describe("pruneContent", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const enabledConfig: PrunerConfig = {
    url: "http://localhost:8000/prune",
    timeoutMs: 30000,
    enabled: true,
  };

  const disabledConfig: PrunerConfig = {
    url: "",
    timeoutMs: 30000,
    enabled: false,
  };

  it("returns original content when pruning is disabled", async () => {
    const result = await pruneContent("original", "query", disabledConfig);
    expect(result).toBe("original");
  });

  it("sends POST with { code, query } payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pruned_code: "pruned" }),
    });
    globalThis.fetch = mockFetch;

    await pruneContent("my code", "my query", enabledConfig);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/prune",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "my code", query: "my query" }),
      }),
    );
  });

  it("accepts pruned_code field from response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pruned_code: "pruned via pruned_code" }),
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("pruned via pruned_code");
  });

  it("accepts content field from response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: "pruned via content" }),
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("pruned via content");
  });

  it("accepts text field from response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "pruned via text" }),
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("pruned via text");
  });

  it("prefers pruned_code over content and text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          pruned_code: "from pruned_code",
          content: "from content",
          text: "from text",
        }),
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("from pruned_code");
  });

  it("returns original content on non-2xx response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content on invalid JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("Unexpected token")),
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content when response is not a JSON object", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve("just a string"),
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content when response missing pruned fields", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ other_field: "data" }),
    });
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content on timeout (AbortError)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });
});
