import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// We test the wiring logic by verifying the SDK options construction
// without actually running the full provider (which requires an API key).
// The key behavior to verify: mcpServers presence/absence in options.

// Mock the Claude Agent SDK so we don't need a real API key
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentProvider } from './claudeAgentSdk.js';
import type { ProviderEvent } from '../provider.js';

const mockedQuery = vi.mocked(query);

function getSystemContent(evt: ProviderEvent): string {
  if (evt.type === 'system') return evt.content;
  return '';
}

describe('ClaudeAgentProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.JEEVES_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('has name "claude-agent-sdk"', () => {
    const provider = new ClaudeAgentProvider();
    expect(provider.name).toBe('claude-agent-sdk');
  });

  describe('mcpServers wiring', () => {
    it('includes mcpServers in SDK options when present in ProviderRunOptions', async () => {
      // Make query return an async iterable that yields nothing (empty run)
      mockedQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          // yield nothing, end immediately
        },
      } as unknown as ReturnType<typeof query>);

      const provider = new ClaudeAgentProvider();
      const mcpServers = {
        pruner: {
          command: 'node',
          args: ['/path/to/mcp-pruner/dist/index.js'] as readonly string[],
          env: { PRUNER_URL: 'http://localhost:8000/prune', MCP_PRUNER_CWD: '/workspace' } as Readonly<Record<string, string>>,
        },
      };

      // Consume the async iterable to trigger the SDK call
      const events: ProviderEvent[] = [];
      for await (const evt of provider.run('test prompt', {
        cwd: '/workspace',
        mcpServers,
      })) {
        events.push(evt);
      }

      // Verify query was called
      expect(mockedQuery).toHaveBeenCalledTimes(1);

      // Extract the options passed to query
      const callArgs = mockedQuery.mock.calls[0];
      const sdkOptions = (callArgs[0] as { options: Record<string, unknown> }).options;

      // mcpServers should be present
      expect(sdkOptions.mcpServers).toBeDefined();
      expect(sdkOptions.mcpServers).toBe(mcpServers);
    });

    it('omits mcpServers from SDK options when not present in ProviderRunOptions', async () => {
      mockedQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          // yield nothing
        },
      } as unknown as ReturnType<typeof query>);

      const provider = new ClaudeAgentProvider();

      const events: ProviderEvent[] = [];
      for await (const evt of provider.run('test prompt', { cwd: '/workspace' })) {
        events.push(evt);
      }

      expect(mockedQuery).toHaveBeenCalledTimes(1);

      const callArgs = mockedQuery.mock.calls[0];
      const sdkOptions = (callArgs[0] as { options: Record<string, unknown> }).options;

      // mcpServers should NOT be present
      expect(sdkOptions.mcpServers).toBeUndefined();
    });
  });

  describe('basic provider events', () => {
    it('emits system:init event on run start', async () => {
      mockedQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          // yield nothing
        },
      } as unknown as ReturnType<typeof query>);

      const provider = new ClaudeAgentProvider();
      const events: ProviderEvent[] = [];
      for await (const evt of provider.run('prompt', { cwd: '/workspace' })) {
        events.push(evt);
      }

      const initEvent = events.find(
        (e) => e.type === 'system' && 'subtype' in e && e.subtype === 'init',
      );
      expect(initEvent).toBeDefined();
      expect(getSystemContent(initEvent!)).toContain('Starting Claude Agent SDK session');
    });

    it('includes model info in init event when JEEVES_MODEL is set', async () => {
      process.env.JEEVES_MODEL = 'sonnet';

      mockedQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          // yield nothing
        },
      } as unknown as ReturnType<typeof query>);

      const provider = new ClaudeAgentProvider();
      const events: ProviderEvent[] = [];
      for await (const evt of provider.run('prompt', { cwd: '/workspace' })) {
        events.push(evt);
      }

      const initEvent = events.find(
        (e) => e.type === 'system' && 'subtype' in e && e.subtype === 'init',
      );
      expect(initEvent).toBeDefined();
      expect(getSystemContent(initEvent!)).toContain('model=');
    });
  });
});
