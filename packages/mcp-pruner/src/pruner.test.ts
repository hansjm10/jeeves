import { describe, expect, it, vi, afterEach } from "vitest";

import { getPrunerConfig, pruneContent, type PrunerConfig } from "./pruner.js";

// ---------------------------------------------------------------------------
// getPrunerConfig
// ---------------------------------------------------------------------------

describe("getPrunerConfig", () => {
  it("returns default URL and timeout when env vars are unset", () => {
    const config = getPrunerConfig({});

    expect(config.url).toBe("http://localhost:8000/prune");
    expect(config.timeoutMs).toBe(30_000);
    expect(config.enabled).toBe(true);
  });

  it("uses PRUNER_URL from env when set", () => {
    const config = getPrunerConfig({ PRUNER_URL: "http://custom:9000/api" });

    expect(config.url).toBe("http://custom:9000/api");
    expect(config.enabled).toBe(true);
  });

  it("disables pruning when PRUNER_URL is empty string", () => {
    const config = getPrunerConfig({ PRUNER_URL: "" });

    expect(config.url).toBe("");
    expect(config.enabled).toBe(false);
  });

  it("uses PRUNER_TIMEOUT_MS from env when valid", () => {
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "5000" });
    expect(config.timeoutMs).toBe(5000);
  });

  it("clamps PRUNER_TIMEOUT_MS below minimum to 100ms", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "50" });

    expect(config.timeoutMs).toBe(100);
    stderrSpy.mockRestore();
  });

  it("clamps PRUNER_TIMEOUT_MS above maximum to 300000ms", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "500000" });

    expect(config.timeoutMs).toBe(300_000);
    stderrSpy.mockRestore();
  });

  it("uses default timeout when PRUNER_TIMEOUT_MS is not a number", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const config = getPrunerConfig({ PRUNER_TIMEOUT_MS: "not-a-number" });

    expect(config.timeoutMs).toBe(30_000);
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// pruneContent
// ---------------------------------------------------------------------------

describe("pruneContent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function enabledConfig(url = "http://localhost:8000/prune"): PrunerConfig {
    return { url, timeoutMs: 30_000, enabled: true };
  }

  function disabledConfig(): PrunerConfig {
    return { url: "", timeoutMs: 30_000, enabled: false };
  }

  it("returns original content when pruning is disabled", async () => {
    const result = await pruneContent("original code", "question", disabledConfig());
    expect(result).toBe("original code");
  });

  it("sends POST with { code, query } and returns pruned_code from response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ pruned_code: "pruned!" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await pruneContent("original code", "my question", enabledConfig());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:8000/prune");
    expect(opts).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const body = JSON.parse(opts!.body as string);
    expect(body).toEqual({ code: "original code", query: "my question" });
    expect(result).toBe("pruned!");
  });

  it("accepts content field from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ content: "content-pruned" }), { status: 200 }),
    );

    const result = await pruneContent("orig", "q", enabledConfig());
    expect(result).toBe("content-pruned");
  });

  it("accepts text field from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "text-pruned" }), { status: 200 }),
    );

    const result = await pruneContent("orig", "q", enabledConfig());
    expect(result).toBe("text-pruned");
  });

  it("prefers pruned_code over content over text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ pruned_code: "pc", content: "ct", text: "tx" }),
        { status: 200 },
      ),
    );

    const result = await pruneContent("orig", "q", enabledConfig());
    expect(result).toBe("pc");
  });

  it("returns original content on non-2xx response", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("error", { status: 500 }),
    );

    const result = await pruneContent("original", "q", enabledConfig());
    expect(result).toBe("original");
    stderrSpy.mockRestore();
  });

  it("returns original content on network error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await pruneContent("original", "q", enabledConfig());
    expect(result).toBe("original");
    stderrSpy.mockRestore();
  });

  it("returns original content when response is not valid JSON", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not json", { status: 200 }),
    );

    const result = await pruneContent("original", "q", enabledConfig());
    expect(result).toBe("original");
    stderrSpy.mockRestore();
  });

  it("returns original content when response is JSON but missing string fields", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ other_field: 123 }), { status: 200 }),
    );

    const result = await pruneContent("original", "q", enabledConfig());
    expect(result).toBe("original");
    stderrSpy.mockRestore();
  });

  it("returns original content when response JSON is not an object", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify("just a string"), { status: 200 }),
    );

    const result = await pruneContent("original", "q", enabledConfig());
    expect(result).toBe("original");
    stderrSpy.mockRestore();
  });

  it("returns original content on abort/timeout", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    const result = await pruneContent("original", "q", enabledConfig());
    expect(result).toBe("original");
    stderrSpy.mockRestore();
  });

  it("passes query verbatim without trimming", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ pruned_code: "ok" }), { status: 200 }),
    );

    await pruneContent("code", "  spaces  around  ", enabledConfig());
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.query).toBe("  spaces  around  ");
  });
});
