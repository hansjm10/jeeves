import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// We test the mcpServers wiring behavior by verifying that the Claude provider
// constructs the correct SDK Options based on ProviderRunOptions.

// The ClaudeAgentProvider calls `query()` from the SDK internally.
// We mock the entire SDK to avoid actually calling the Claude API.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentProvider } from './claudeAgentSdk.js';

const mockedQuery = vi.mocked(query);

describe('ClaudeAgentProvider mcpServers wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    // Clear any model env to avoid validateModel throwing
    delete process.env.JEEVES_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function makeAsyncIterable<T>(values: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i >= values.length) return { done: true as const, value: undefined };
            return { done: false as const, value: values[i++] };
          },
        };
      },
    };
  }

  it('includes mcpServers in SDK options when provided in ProviderRunOptions', async () => {
    const mcpServers = {
      pruner: {
        command: 'node',
        args: ['/path/to/index.js'],
        env: { PRUNER_URL: 'http://localhost:8000/prune', MCP_PRUNER_CWD: '/test' },
      },
    };

    mockedQuery.mockReturnValue(makeAsyncIterable([
      { type: 'result', subtype: 'success', result: 'done', session_id: 's1' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ]) as any);

    const provider = new ClaudeAgentProvider();
    const events: unknown[] = [];
    for await (const evt of provider.run('test prompt', { cwd: '/test', mcpServers })) {
      events.push(evt);
    }

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockedQuery.mock.calls[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (callArgs[0] as any).options;
    expect(sdkOptions.mcpServers).toEqual(mcpServers);
  });

  it('omits mcpServers from SDK options when not provided', async () => {
    mockedQuery.mockReturnValue(makeAsyncIterable([
      { type: 'result', subtype: 'success', result: 'done', session_id: 's1' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ]) as any);

    const provider = new ClaudeAgentProvider();
    const events: unknown[] = [];
    for await (const evt of provider.run('test prompt', { cwd: '/test' })) {
      events.push(evt);
    }

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockedQuery.mock.calls[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (callArgs[0] as any).options;
    expect(sdkOptions.mcpServers).toBeUndefined();
  });

  it('resolves valid Claude model aliases from JEEVES_MODEL', async () => {
    process.env.JEEVES_MODEL = 'sonnet';

    mockedQuery.mockReturnValue(makeAsyncIterable([
      { type: 'result', subtype: 'success', result: 'done', session_id: 's1' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ]) as any);

    const provider = new ClaudeAgentProvider();
    const events: unknown[] = [];
    for await (const evt of provider.run('test prompt', { cwd: '/test' })) {
      events.push(evt);
    }

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockedQuery.mock.calls[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (callArgs[0] as any).options;
    expect(sdkOptions.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('accepts full claude model IDs from JEEVES_MODEL', async () => {
    process.env.JEEVES_MODEL = 'claude-sonnet-4-5-20250929';

    mockedQuery.mockReturnValue(makeAsyncIterable([
      { type: 'result', subtype: 'success', result: 'done', session_id: 's1' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ]) as any);

    const provider = new ClaudeAgentProvider();
    const events: unknown[] = [];
    for await (const evt of provider.run('test prompt', { cwd: '/test' })) {
      events.push(evt);
    }

    const callArgs = mockedQuery.mock.calls[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (callArgs[0] as any).options;
    expect(sdkOptions.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('throws on invalid model names', async () => {
    process.env.JEEVES_MODEL = 'gpt-5.3-codex';

    const provider = new ClaudeAgentProvider();
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _evt of provider.run('test prompt', { cwd: '/test' })) {
        // consume
      }
    }).rejects.toThrow(/Invalid model for Claude provider/);
  });

  it('omits model from SDK options when JEEVES_MODEL is not set', async () => {
    delete process.env.JEEVES_MODEL;

    mockedQuery.mockReturnValue(makeAsyncIterable([
      { type: 'result', subtype: 'success', result: 'done', session_id: 's1' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ]) as any);

    const provider = new ClaudeAgentProvider();
    const events: unknown[] = [];
    for await (const evt of provider.run('test prompt', { cwd: '/test' })) {
      events.push(evt);
    }

    const callArgs = mockedQuery.mock.calls[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkOptions = (callArgs[0] as any).options;
    expect(sdkOptions.model).toBeUndefined();
  });
});
