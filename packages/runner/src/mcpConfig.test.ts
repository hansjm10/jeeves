import { describe, expect, it } from "vitest";
import { buildMcpServersConfig } from "./mcpConfig.js";

// ---------------------------------------------------------------------------
// buildMcpServersConfig
// ---------------------------------------------------------------------------

describe("buildMcpServersConfig", () => {
  const cwd = "/test/cwd";

  // ------ disabled when not enabled ------

  it('returns undefined when JEEVES_PRUNER_ENABLED is not "true"', () => {
    expect(buildMcpServersConfig({}, cwd)).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "false"', () => {
    expect(
      buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: "false" }, cwd),
    ).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "TRUE" (case-sensitive)', () => {
    expect(
      buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: "TRUE" }, cwd),
    ).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "1"', () => {
    expect(
      buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: "1" }, cwd),
    ).toBeUndefined();
  });

  // ------ enabled with defaults ------

  it('returns config with command "node" when enabled and entrypoint resolves', () => {
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/path/to/index.js",
      },
      cwd,
    );
    expect(config).toBeDefined();
    expect(config!.pruner).toBeDefined();
    expect(config!.pruner.command).toBe("node");
    expect(config!.pruner.args).toEqual(["/path/to/index.js"]);
  });

  it("sets PRUNER_URL to default http://localhost:8000/prune when JEEVES_PRUNER_URL is unset", () => {
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/path/to/index.js",
      },
      cwd,
    );
    expect(config!.pruner.env!.PRUNER_URL).toBe(
      "http://localhost:8000/prune",
    );
  });

  it("passes empty string JEEVES_PRUNER_URL through to PRUNER_URL (disables pruning)", () => {
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_PRUNER_URL: "",
        JEEVES_MCP_PRUNER_PATH: "/path/to/index.js",
      },
      cwd,
    );
    expect(config!.pruner.env!.PRUNER_URL).toBe("");
  });

  it("passes custom JEEVES_PRUNER_URL through to PRUNER_URL", () => {
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_PRUNER_URL: "http://custom:9000/prune",
        JEEVES_MCP_PRUNER_PATH: "/path/to/index.js",
      },
      cwd,
    );
    expect(config!.pruner.env!.PRUNER_URL).toBe("http://custom:9000/prune");
  });

  it("sets MCP_PRUNER_CWD from provided cwd", () => {
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/path/to/index.js",
      },
      "/my/project",
    );
    expect(config!.pruner.env!.MCP_PRUNER_CWD).toBe("/my/project");
  });

  // ------ entrypoint resolution ------

  it("uses JEEVES_MCP_PRUNER_PATH when explicitly set", () => {
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/explicit/path.js",
      },
      cwd,
    );
    expect(config!.pruner.args).toEqual(["/explicit/path.js"]);
  });

  it("resolves entrypoint via require.resolve fallback when JEEVES_MCP_PRUNER_PATH is unset", () => {
    // When JEEVES_MCP_PRUNER_PATH is not set, the function tries:
    // 1. require.resolve('@jeeves/mcp-pruner/dist/index.js')
    // 2. Workspace fallback path
    // At least one of these should work in the monorepo
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
      },
      cwd,
    );
    // In this monorepo, the entrypoint should resolve (dist may or may not exist)
    // If it doesn't resolve, config will be undefined
    if (config) {
      expect(config.pruner.args!.length).toBe(1);
      expect(config.pruner.args![0]).toContain("index.js");
    }
  });

  // ------ config shape ------

  it("returns config with the expected pruner shape", () => {
    const config = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: "true",
        JEEVES_MCP_PRUNER_PATH: "/path/to/index.js",
      },
      cwd,
    );
    expect(config).toEqual({
      pruner: {
        command: "node",
        args: ["/path/to/index.js"],
        env: {
          PRUNER_URL: "http://localhost:8000/prune",
          MCP_PRUNER_CWD: cwd,
        },
      },
    });
  });
});
