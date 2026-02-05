import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrunerHook } from './prunerHook.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PrunerHook', () => {
  it('is a no-op when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hook = new PrunerHook({
      prunerUrl: 'http://example/prune',
      enabled: false,
      targetTools: ['Read'],
      query: 'q',
    });

    const out = await hook.onToolResult(
      { type: 'tool_result', toolUseId: 't1', content: 'orig' },
      { toolUseId: 't1', toolName: 'Read', input: {} },
    );

    expect(out.content).toBe('orig');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the pruner and replaces tool_result content', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ pruned_code: 'pruned', code: 'orig' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const hook = new PrunerHook({
      prunerUrl: 'http://example/prune',
      enabled: true,
      targetTools: ['Read'],
      query: 'q',
      timeoutMs: 1000,
    });

    const out = await hook.onToolResult(
      { type: 'tool_result', toolUseId: 't1', content: 'orig' },
      { toolUseId: 't1', toolName: 'Read', input: { path: 'x' } },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.content).toBe('pruned');
  });

  it('skips tools not in targetTools', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hook = new PrunerHook({
      prunerUrl: 'http://example/prune',
      enabled: true,
      targetTools: ['Read'],
      query: 'q',
    });

    const out = await hook.onToolResult(
      { type: 'tool_result', toolUseId: 't1', content: 'orig' },
      { toolUseId: 't1', toolName: 'Bash', input: {} },
    );

    expect(out.content).toBe('orig');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
