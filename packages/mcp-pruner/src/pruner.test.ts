import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getPrunerConfig, pruneContent, type PrunerConfig } from "./pruner.js";

// ---------------------------------------------------------------------------
// getPrunerConfig
// ---------------------------------------------------------------------------

describe("getPrunerConfig", () => {
  it("returns default URL and timeout when env is empty", () => {
    const config = getPrunerConfig({});
    expect(config.url).toBe("http://localhost:8000/prune");
    expect(config.timeoutMs).toBe(30_000);
    expect(config.enabled).toBe(true);
  });

  it("returns custom URL from PRUNER_URL", () => {
    const config = getPrunerConfig({ PRUNER_URL: "http://custom:9000/prune" });
    expect(config.url).toBe("http://custom:9000/prune");
    expect(config.enabled).toBe(true);
  });

  it("disables pruning when PRUNER_URL is empty string", () => {
    const config = getPrunerConfig({ PRUNER_URL: "" });
    expect(config.url).toBe("");
    expect(config.enabled).toBe(false);
  });

  it("parses PRUNER_TIMEOUT_MS as integer", () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "5000" });
    expect(config.timeoutMs).toBe(5000);
  });

  it("uses default timeout for invalid PRUNER_TIMEOUT_MS", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "not-a-number" });
    expect(config.timeoutMs).toBe(30_000);
    stderrSpy.mockRestore();
  });

  it("clamps PRUNER_TIMEOUT_MS below minimum to 100", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "10" });
    expect(config.timeoutMs).toBe(100);
    stderrSpy.mockRestore();
  });

  it("clamps PRUNER_TIMEOUT_MS above maximum to 300000", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "500000" });
    expect(config.timeoutMs).toBe(300_000);
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// pruneContent
// ---------------------------------------------------------------------------

describe("pruneContent", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (fetchSpy) fetchSpy.mockRestore();
  });

  const enabledConfig: PrunerConfig = {
    url: "http://localhost:8000/prune",
    timeoutMs: 30_000,
    enabled: true,
  };

  const disabledConfig: PrunerConfig = {
    url: "",
    timeoutMs: 30_000,
    enabled: false,
  };

  it("returns original content when pruning is disabled", async () => {
    const result = await pruneContent("original", "query", disabledConfig);
    expect(result).toBe("original");
  });

  it("sends POST with { code, query } payload", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ pruned_code: "pruned" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await pruneContent("my code", "my question", enabledConfig);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8000/prune",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "my code", query: "my question" }),
      }),
    );
  });

  it("accepts pruned_code from response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ pruned_code: "pruned via pruned_code" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("pruned via pruned_code");
  });

  it("accepts content from response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ content: "pruned via content" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("pruned via content");
  });

  it("accepts text from response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "pruned via text" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("pruned via text");
  });

  it("prefers pruned_code over content and text", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pruned_code: "winner",
          content: "loser1",
          text: "loser2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("winner");
  });

  // ------ fallback behaviors ------

  it("returns original content on non-2xx response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Server Error", { status: 500 }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content on network error", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network error"));
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content on invalid JSON response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content when response is missing pruned fields", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ other_field: "value" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("returns original content when response is not a JSON object", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify("just a string"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });

  it("never throws on any failure", async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await pruneContent("original", "query", enabledConfig);
    expect(result).toBe("original");
  });
});
