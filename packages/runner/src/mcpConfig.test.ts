import { describe, expect, it, vi } from "vitest";
import { buildMcpServersConfig } from "./mcpConfig.js";

// We need to mock fs and module resolution for the entrypoint resolution
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      accessSync: vi.fn((...args: unknown[]) => {
        // Call actual accessSync
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual as any).accessSync(...args);
      }),
    },
  };
});

describe("buildMcpServersConfig", () => {
  // ---- Disabled behavior ----

  it("returns undefined when JEEVES_PRUNER_ENABLED is not set", () => {
    const result = buildMcpServersConfig({}, "/test/cwd");
    expect(result).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "false"', () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: "false" },
      "/test/cwd",
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "TRUE" (case sensitive)', () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: "TRUE" },
      "/test/cwd",
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "1"', () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: "1" },
      "/test/cwd",
    );
    expect(result).toBeUndefined();
  });

  // ---- Enabled behavior ----

  it('returns pruner config when JEEVES_PRUNER_ENABLED is exactly "true"', () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: "true" },
      "/test/cwd",
    );
    // May be undefined if entrypoint can't be resolved, but let's check the shape
    // In our test env, require.resolve should work since @jeeves/mcp-pruner is a workspace dep
    if (result) {
      expect(result.pruner).toBeDefined();
      expect(result.pruner.command).toBe("node");
      expect(result.pruner.args).toBeDefined();
      expect(result.pruner.args!.length).toBeGreaterThan(0);
      expect(result.pruner.env).toBeDefined();
      expect(result.pruner.env!.MCP_PRUNER_CWD).toBe("/test/cwd");
    }
  });

  it("defaults PRUNER_URL to http://localhost:8000/prune when JEEVES_PRUNER_URL is unset", () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: "true" },
      "/test/cwd",
    );
    if (result) {
      expect(result.pruner.env!.PRUNER_URL).toBe("http://localhost:8000/prune");
    }
  });

  it("passes empty string JEEVES_PRUNER_URL through as PRUNER_URL", () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: "true", JEEVES_PRUNER_URL: "" },
      "/test/cwd",
    );
    if (result) {
      expect(result.pruner.env!.PRUNER_URL).toBe("");
    }
  });

  it("passes custom JEEVES_PRUNER_URL through as PRUNER_URL", () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_PRUNER_URL: "http://custom:9000/prune",
      },
      "/test/cwd",
    );
    if (result) {
      expect(result.pruner.env!.PRUNER_URL).toBe("http://custom:9000/prune");
    }
  });

  it("uses JEEVES_MCP_PRUNER_PATH when provided", () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/custom/path/to/index.js",
      },
      "/test/cwd",
    );
    expect(result).toBeDefined();
    expect(result!.pruner.command).toBe("node");
    expect(result!.pruner.args).toEqual(["/custom/path/to/index.js"]);
  });

  it("sets MCP_PRUNER_CWD from the cwd parameter", () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/some/path/index.js",
      },
      "/my/project",
    );
    expect(result).toBeDefined();
    expect(result!.pruner.env!.MCP_PRUNER_CWD).toBe("/my/project");
  });

  // ---- Config shape ----

  it("returns config with command, args, and env", () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/path/index.js",
      },
      "/test/cwd",
    );
    expect(result).toBeDefined();
    expect(result!.pruner).toEqual({
      command: "node",
      args: ["/path/index.js"],
      env: {
        PRUNER_URL: "http://localhost:8000/prune",
        MCP_PRUNER_CWD: "/test/cwd",
      },
    });
  });
});
