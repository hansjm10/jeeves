import { describe, expect, it, vi } from "vitest";

/**
 * Tests for Claude Agent SDK provider mcpServers wiring.
 *
 * These tests verify that:
 * 1. When mcpServers is present in ProviderRunOptions, it is included in SDK Options.
 * 2. When mcpServers is absent, it is omitted from SDK Options.
 *
 * Since the actual Claude SDK call (`query`) requires authentication and network,
 * we test the wiring by mocking the SDK module and verifying the options passed.
 */

/** Drain an async iterable without using the yielded values. */
async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const unused of iter) {
    void unused;
  }
}

describe("ClaudeAgentProvider mcpServers wiring", () => {
  it("includes mcpServers in SDK options when provided", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    // Mock the SDK to capture the options
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
        capturedOptions = options;
        // Return an async iterable that immediately completes
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              result: "done",
            };
          },
        };
      },
    }));

    // Re-import to get the mocked version
    const mod = await import("./claudeAgentSdk.js");
    const provider = new mod.ClaudeAgentProvider();

    const mcpServers = {
      pruner: {
        command: "node",
        args: ["/path/to/mcp-pruner/dist/index.js"],
        env: { PRUNER_URL: "http://localhost:8000/prune" },
      },
    };

    // Consume the async iterable
    await drain(provider.run("test prompt", {
      cwd: "/test",
      mcpServers,
    }));

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.mcpServers).toEqual(mcpServers);

    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("omits mcpServers from SDK options when not provided", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: ({ options }: { prompt: string; options: Record<string, unknown> }) => {
        capturedOptions = options;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              result: "done",
            };
          },
        };
      },
    }));

    const mod = await import("./claudeAgentSdk.js");
    const provider = new mod.ClaudeAgentProvider();

    await drain(provider.run("test prompt", {
      cwd: "/test",
    }));

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.mcpServers).toBeUndefined();

    vi.restoreAllMocks();
    vi.resetModules();
  });
});
