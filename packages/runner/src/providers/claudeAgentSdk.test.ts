import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the @anthropic-ai/claude-agent-sdk module BEFORE importing the provider
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentProvider } from './claudeAgentSdk.js';
import type { ProviderRunOptions } from '../provider.js';

function setupQueryMock(): void {
  vi.mocked(query).mockReturnValue(
    (async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', session_id: 's1' };
    })() as ReturnType<typeof query>,
  );
}

/** Get the options passed to the most recent query() call. */
function lastQueryOptions(): Record<string, unknown> {
  const calls = vi.mocked(query).mock.calls;
  const lastCall = calls[calls.length - 1];
  return (lastCall[0] as unknown as { options: Record<string, unknown> }).options;
}

describe('ClaudeAgentProvider', () => {
  let provider: ClaudeAgentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeAgentProvider();
    setupQueryMock();
    // Clear JEEVES_MODEL to avoid model validation interference
    delete process.env.JEEVES_MODEL;
  });

  it('has name "claude-agent-sdk"', () => {
    expect(provider.name).toBe('claude-agent-sdk');
  });

  // -------------------------------------------------------------------------
  // mcpServers presence/absence
  // -------------------------------------------------------------------------

  it('includes mcpServers in SDK options when provided', async () => {
    const mcpServers = {
      pruner: {
        command: 'node',
        args: ['/path/to/mcp-pruner/dist/index.js'] as readonly string[],
        env: { PRUNER_URL: 'http://localhost:8000/prune', MCP_PRUNER_CWD: '/work' } as Readonly<Record<string, string>>,
      },
    };

    const options: ProviderRunOptions = {
      cwd: '/work',
      mcpServers,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of provider.run('test prompt', options)) { /* consume */ }

    const opts = lastQueryOptions();
    expect(opts).toHaveProperty('mcpServers');
    expect(opts.mcpServers).toEqual(mcpServers);
  });

  it('omits mcpServers from SDK options when not provided', async () => {
    const options: ProviderRunOptions = {
      cwd: '/work',
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of provider.run('test prompt', options)) { /* consume */ }

    const opts = lastQueryOptions();
    expect(opts).not.toHaveProperty('mcpServers');
  });

  it('omits mcpServers when mcpServers is undefined', async () => {
    const options: ProviderRunOptions = {
      cwd: '/work',
      mcpServers: undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of provider.run('test prompt', options)) { /* consume */ }

    const opts = lastQueryOptions();
    expect(opts).not.toHaveProperty('mcpServers');
  });

  // -------------------------------------------------------------------------
  // SDK options shape
  // -------------------------------------------------------------------------

  it('sets permissionMode to bypassPermissions', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of provider.run('prompt', { cwd: '/work' })) { /* consume */ }

    const opts = lastQueryOptions();
    expect(opts.permissionMode).toBe('bypassPermissions');
  });

  it('passes cwd to SDK options', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of provider.run('prompt', { cwd: '/my/dir' })) { /* consume */ }

    const opts = lastQueryOptions();
    expect(opts.cwd).toBe('/my/dir');
  });

  // -------------------------------------------------------------------------
  // Event mapping
  // -------------------------------------------------------------------------

  it('emits system:init event first', async () => {
    const events = [];
    for await (const evt of provider.run('prompt', { cwd: '/work' })) {
      events.push(evt);
    }

    expect(events[0]).toEqual(
      expect.objectContaining({
        type: 'system',
        subtype: 'init',
        content: expect.stringContaining('Starting Claude Agent SDK session'),
      }),
    );
  });

  it('maps result message to result event', async () => {
    const events = [];
    for await (const evt of provider.run('prompt', { cwd: '/work' })) {
      events.push(evt);
    }

    const resultEvents = events.filter((e) => e.type === 'result');
    expect(resultEvents.length).toBeGreaterThan(0);
    expect(resultEvents[0]).toEqual(
      expect.objectContaining({
        type: 'result',
        content: 'done',
      }),
    );
  });
});
