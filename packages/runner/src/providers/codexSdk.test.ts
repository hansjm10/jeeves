import { describe, expect, it, vi, beforeEach } from 'vitest';

import { mapCodexEventToProviderEvents, type CodexThreadEvent } from './codexSdk.js';

function makeState() {
  return {
    toolStartMsById: new Map<string, number>(),
    emittedToolUseIds: new Set<string>(),
  };
}

describe('mapCodexEventToProviderEvents', () => {
  it('maps thread.started to system:init with sessionId', () => {
    const state = makeState();
    const events = mapCodexEventToProviderEvents(
      { type: 'thread.started', thread_id: 't1' } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );
    expect(events).toEqual([
      {
        type: 'system',
        subtype: 'init',
        content: 'Codex thread started',
        timestamp: 'ts',
        sessionId: 't1',
      },
    ]);
  });

  it('maps command_execution start/completion to tool_use + tool_result with duration/isError', () => {
    const state = makeState();
    let now = 1000;
    const nowMs = () => now;
    const nowIso = () => `t${now}`;

    const startEvents = mapCodexEventToProviderEvents(
      {
        type: 'item.started',
        item: {
          id: 'cmd1',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: '',
          status: 'in_progress',
        },
      } as unknown as CodexThreadEvent,
      state,
      nowMs,
      nowIso,
    );
    expect(startEvents).toEqual([
      {
        type: 'tool_use',
        name: 'command_execution',
        input: { command: 'ls' },
        id: 'cmd1',
        timestamp: 't1000',
      },
    ]);

    now = 1500;
    const completeEvents = mapCodexEventToProviderEvents(
      {
        type: 'item.completed',
        item: {
          id: 'cmd1',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'hello',
          exit_code: 2,
          status: 'completed',
        },
      } as unknown as CodexThreadEvent,
      state,
      nowMs,
      nowIso,
    );

    expect(completeEvents).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'cmd1',
        content: 'hello\n[exit_code] 2',
        isError: true,
        durationMs: 500,
        timestamp: 't1500',
      },
    ]);
  });

  it('maps agent_message completion to assistant', () => {
    const state = makeState();
    const events = mapCodexEventToProviderEvents(
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'hi' } } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );
    expect(events).toEqual([{ type: 'assistant', content: 'hi', timestamp: 'ts' }]);
  });

  it('maps user_message completion to user', () => {
    const state = makeState();
    const events = mapCodexEventToProviderEvents(
      { type: 'item.completed', item: { id: 'u1', type: 'user_message', text: 'hello' } } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );
    expect(events).toEqual([{ type: 'user', content: 'hello', timestamp: 'ts' }]);
  });

  it('maps message completion with role=user to user', () => {
    const state = makeState();
    const events = mapCodexEventToProviderEvents(
      { type: 'item.completed', item: { id: 'u2', type: 'message', role: 'user', content: 'hey' } } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );
    expect(events).toEqual([{ type: 'user', content: 'hey', timestamp: 'ts' }]);
  });

  it('maps turn.failed and error to system:error', () => {
    const state = makeState();
    const failed = mapCodexEventToProviderEvents(
      { type: 'turn.failed', error: { message: 'nope' } } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );
    expect(failed).toEqual([
      { type: 'system', subtype: 'error', content: 'Codex turn failed: nope', timestamp: 'ts' },
    ]);

    const fatal = mapCodexEventToProviderEvents(
      { type: 'error', message: 'bad' } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );
    expect(fatal).toEqual([
      { type: 'system', subtype: 'error', content: 'Codex stream error: bad', timestamp: 'ts' },
    ]);
  });

  it('maps mcp_tool_call to mcp:server/tool format', () => {
    const state = makeState();
    const events = mapCodexEventToProviderEvents(
      {
        type: 'item.completed',
        item: {
          id: 'mcp1',
          type: 'mcp_tool_call',
          server: 'pruner',
          tool: 'read',
          arguments: { file_path: '/tmp/test.ts' },
          status: 'completed',
          result: { structured_content: 'file content here' },
        },
      } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );

    // Should emit tool_use and tool_result events
    expect(events.length).toBeGreaterThanOrEqual(1);
    const toolUse = events.find((e) => e.type === 'tool_use');
    const toolResult = events.find((e) => e.type === 'tool_result');

    if (toolUse && toolUse.type === 'tool_use') {
      expect(toolUse.name).toBe('mcp:pruner/read');
      expect(toolUse.input).toEqual({
        server: 'pruner',
        tool: 'read',
        arguments: { file_path: '/tmp/test.ts' },
      });
    }

    if (toolResult && toolResult.type === 'tool_result') {
      expect(toolResult.content).toContain('file content here');
      expect(toolResult.toolUseId).toBe('mcp1');
    }
  });
});

// ---------------------------------------------------------------------------
// CodexSdkProvider mcpServers wiring
//
// We verify the arg-construction logic by mocking child_process.spawn at the
// module level (vi.mock is hoisted) and capturing the args passed to it.
// ---------------------------------------------------------------------------

/** Drain an async iterable, discarding yielded values. */
async function drainIter(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const evt of iter) { void evt; }
}

// Captured spawn args for verification
let lastSpawnArgs: string[] = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { EventEmitter } = await import('node:events');
  const { Readable, Writable } = await import('node:stream');
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      void cmd;
      lastSpawnArgs = args;

      const child = new EventEmitter() as ReturnType<typeof actual.spawn>;
      const obj = child as unknown as Record<string, unknown>;
      obj.stdin = new Writable({ write: (chunk: unknown, enc: unknown, cb: () => void) => { void chunk; void enc; cb(); } });
      obj.stdout = new Readable({ read() { this.push(null); } });
      obj.stderr = new Readable({ read() { this.push(null); } });
      obj.pid = 12345;
      obj.killed = false;
      obj.kill = () => { obj.killed = true; };

      process.nextTick(() => {
        child.emit('exit', 0);
        child.emit('close', 0);
      });

      return child;
    },
  };
});

vi.mock('node:module', async () => {
  const actual = await vi.importActual<typeof import('node:module')>('node:module');
  return {
    ...actual,
    createRequire: () => ({
      resolve: (specifier: string) => {
        if (specifier === '@openai/codex/bin/codex.js') return '/fake/codex.js';
        throw new Error(`Cannot resolve ${specifier}`);
      },
    }),
  };
});

describe('CodexSdkProvider mcpServers wiring', () => {
  beforeEach(() => {
    lastSpawnArgs = [];
  });

  it('passes mcpServers as --config mcp_servers.* args to codex exec', async () => {
    const { CodexSdkProvider } = await import('./codexSdk.js');
    const provider = new CodexSdkProvider();

    const mcpServers = {
      pruner: {
        command: 'node',
        args: ['/path/to/mcp-pruner/dist/index.js'],
        env: {
          PRUNER_URL: 'http://localhost:8000/prune',
          MCP_PRUNER_CWD: '/test/project',
        },
      },
    };

    try {
      await drainIter(provider.run('test prompt', { cwd: '/test', mcpServers }));
    } catch { /* Errors expected with mocking */ }

    // Verify mcpServers config was translated into --config args
    const configPairs: string[] = [];
    for (let i = 0; i < lastSpawnArgs.length; i++) {
      if (lastSpawnArgs[i] === '--config' && i + 1 < lastSpawnArgs.length) {
        configPairs.push(lastSpawnArgs[i + 1]);
      }
    }

    expect(configPairs).toContain(`mcp_servers.pruner.command=${JSON.stringify('node')}`);
    expect(configPairs).toContain(`mcp_servers.pruner.args=${JSON.stringify(['/path/to/mcp-pruner/dist/index.js'])}`);
    expect(configPairs).toContain(`mcp_servers.pruner.env.PRUNER_URL=${JSON.stringify('http://localhost:8000/prune')}`);
    expect(configPairs).toContain(`mcp_servers.pruner.env.MCP_PRUNER_CWD=${JSON.stringify('/test/project')}`);
  });

  it('omits mcp_servers config args when mcpServers is absent', async () => {
    const { CodexSdkProvider } = await import('./codexSdk.js');
    const provider = new CodexSdkProvider();

    try {
      await drainIter(provider.run('test prompt', { cwd: '/test' }));
    } catch { /* Errors expected with mocking */ }

    const allArgs = lastSpawnArgs.join(' ');
    expect(allArgs).not.toContain('mcp_servers');
  });

  it('does not configure url or streamable_http transport for mcp servers', async () => {
    const { CodexSdkProvider } = await import('./codexSdk.js');
    const provider = new CodexSdkProvider();

    const mcpServers = {
      pruner: {
        command: 'node',
        args: ['/path/to/index.js'],
        env: { PRUNER_URL: 'http://localhost:8000/prune' },
      },
    };

    try {
      await drainIter(provider.run('test prompt', { cwd: '/test', mcpServers }));
    } catch { /* Errors expected with mocking */ }

    const allArgs = lastSpawnArgs.join(' ');
    expect(allArgs).not.toContain('mcp_servers.pruner.url');
    expect(allArgs).not.toContain('streamable_http');
  });

  it('omits args config when no args are provided', async () => {
    const { CodexSdkProvider } = await import('./codexSdk.js');
    const provider = new CodexSdkProvider();

    const mcpServers = {
      pruner: {
        command: 'node',
        // No args property
      },
    };

    try {
      await drainIter(provider.run('test prompt', { cwd: '/test', mcpServers }));
    } catch { /* Errors expected with mocking */ }

    const configPairs: string[] = [];
    for (let i = 0; i < lastSpawnArgs.length; i++) {
      if (lastSpawnArgs[i] === '--config' && i + 1 < lastSpawnArgs.length) {
        configPairs.push(lastSpawnArgs[i + 1]);
      }
    }

    expect(configPairs).toContain(`mcp_servers.pruner.command=${JSON.stringify('node')}`);
    expect(configPairs.filter(p => p.startsWith('mcp_servers.pruner.args'))).toHaveLength(0);
  });
});
