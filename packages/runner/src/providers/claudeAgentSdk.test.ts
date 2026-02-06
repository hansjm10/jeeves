import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * Tests for Claude Agent SDK provider MCP wiring.
 *
 * We cannot run the actual Claude SDK in tests (requires API keys, etc.),
 * so we mock the SDK's `query` function and verify that the Options passed
 * to it include or omit mcpServers based on ProviderRunOptions.
 */

// Capture the options passed to the SDK query function
let capturedSdkOptions: Record<string, unknown> | undefined;

// Mock the claude-agent-sdk module before importing the provider
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }: { prompt: string; options: Record<string, unknown> }) => {
    capturedSdkOptions = options;
    // Return an async iterable that immediately completes
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", subtype: "success", result: "done" };
      },
    };
  }),
}));

import { ClaudeAgentProvider } from "./claudeAgentSdk.js";

describe("ClaudeAgentProvider – mcpServers wiring", () => {
  afterEach(() => {
    capturedSdkOptions = undefined;
    vi.restoreAllMocks();
  });

  it("includes mcpServers in SDK options when present in ProviderRunOptions", async () => {
    const provider = new ClaudeAgentProvider();
    const mcpServers = {
      pruner: {
        command: "node",
        args: ["/path/to/index.js"],
        env: { PRUNER_URL: "http://localhost:8000/prune", MCP_PRUNER_CWD: "/work" },
      },
    };

    // Consume the async iterable
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _evt of provider.run("test prompt", {
      cwd: "/work",
      mcpServers,
    })) {
      // just consume events
    }

    expect(capturedSdkOptions).toBeDefined();
    expect(capturedSdkOptions!.mcpServers).toBeDefined();
    expect(capturedSdkOptions!.mcpServers).toEqual(mcpServers);
  });

  it("omits mcpServers from SDK options when absent from ProviderRunOptions", async () => {
    const provider = new ClaudeAgentProvider();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _evt of provider.run("test prompt", {
      cwd: "/work",
    })) {
      // just consume events
    }

    expect(capturedSdkOptions).toBeDefined();
    expect(capturedSdkOptions!.mcpServers).toBeUndefined();
  });

  it("has name 'claude-agent-sdk'", () => {
    const provider = new ClaudeAgentProvider();
    expect(provider.name).toBe("claude-agent-sdk");
  });
});
