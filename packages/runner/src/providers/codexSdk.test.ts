import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';

import { mapCodexEventToProviderEvents, type CodexThreadEvent, CodexSdkProvider } from './codexSdk.js';

// Mock child_process.spawn so CodexSdkProvider.run doesn't actually launch codex
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

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

  it('maps mcp_tool_call to mcp:<server>/<tool> name', () => {
    const state = makeState();
    const events = mapCodexEventToProviderEvents(
      {
        type: 'item.started',
        item: {
          id: 'mcp1',
          type: 'mcp_tool_call',
          server: 'pruner',
          tool: 'read',
          arguments: { file_path: '/test.ts' },
          status: 'in_progress',
        },
      } as unknown as CodexThreadEvent,
      state,
      () => 0,
      () => 'ts',
    );
    expect(events).toEqual([
      {
        type: 'tool_use',
        name: 'mcp:pruner/read',
        input: {
          server: 'pruner',
          tool: 'read',
          arguments: { file_path: '/test.ts' },
        },
        id: 'mcp1',
        timestamp: 'ts',
      },
    ]);
  });
});

describe('CodexSdkProvider MCP wiring', () => {
  const provider = new CodexSdkProvider();

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    delete process.env.JEEVES_MODEL;
    delete process.env.CODEX_MODEL;
    delete process.env.OPENAI_MODEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to capture the args that spawn is called with.
   * Since run() tries to write to stdin and read from stdout/stderr,
   * we create a minimal mock child process.
   */
  function setupMockSpawn(): { getSpawnArgs: () => string[] } {

    const mockStdin = new PassThrough();
    const mockStdout = new Readable({ read() { this.push(null); } });
    const mockStderr = new Readable({ read() { this.push(null); } });

    const mockChild = {
      stdin: mockStdin,
      stdout: mockStdout,
      stderr: mockStderr,
      killed: false,
      kill: vi.fn(),
      once: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit' || event === 'close') {
          setTimeout(() => cb(0), 10);
        }
      }),
      removeAllListeners: vi.fn(),
      on: vi.fn(),
    };

    mockStderr.on = vi.fn().mockReturnThis();

    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    return {
      getSpawnArgs: () => {
        const call = vi.mocked(spawn).mock.calls[0];
        return call ? (call[1] as string[]) : [];
      },
    };
  }

  it('includes mcp_servers config args when mcpServers is provided', async () => {
    const { getSpawnArgs } = setupMockSpawn();

    const options = {
      cwd: '/work',
      mcpServers: {
        pruner: {
          command: 'node' as const,
          args: ['/path/to/mcp-pruner/dist/index.js'] as readonly string[],
          env: {
            PRUNER_URL: 'http://localhost:8000/prune',
            MCP_PRUNER_CWD: '/work',
          } as Readonly<Record<string, string>>,
        },
      },
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.run('test', options)) { /* consume */ }
    } catch {
      // spawn mock may throw; we only care about the args
    }

    const args = getSpawnArgs();

    // Verify mcp_servers.pruner.command
    expect(args).toContain('--config');
    const configArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--config');
    expect(configArgs).toContainEqual(`mcp_servers.pruner.command=${JSON.stringify('node')}`);

    // Verify mcp_servers.pruner.args
    expect(configArgs).toContainEqual(
      `mcp_servers.pruner.args=${JSON.stringify(['/path/to/mcp-pruner/dist/index.js'])}`,
    );

    // Verify mcp_servers.pruner.env.PRUNER_URL
    expect(configArgs).toContainEqual(
      `mcp_servers.pruner.env.PRUNER_URL=${JSON.stringify('http://localhost:8000/prune')}`,
    );

    // Verify mcp_servers.pruner.env.MCP_PRUNER_CWD
    expect(configArgs).toContainEqual(
      `mcp_servers.pruner.env.MCP_PRUNER_CWD=${JSON.stringify('/work')}`,
    );
  });

  it('does not include mcp_servers config args when mcpServers is absent', async () => {
    const { getSpawnArgs } = setupMockSpawn();

    const options = {
      cwd: '/work',
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.run('test', options)) { /* consume */ }
    } catch {
      // spawn mock may throw
    }

    const args = getSpawnArgs();
    const configArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--config');

    // No mcp_servers entries
    const mcpConfigs = configArgs.filter((a) => a.startsWith('mcp_servers.'));
    expect(mcpConfigs).toHaveLength(0);
  });

  it('omits args when mcpServers entry has no args', async () => {
    const { getSpawnArgs } = setupMockSpawn();

    const options = {
      cwd: '/work',
      mcpServers: {
        pruner: {
          command: 'node' as const,
          env: { PRUNER_URL: 'http://localhost:8000/prune' } as Readonly<Record<string, string>>,
        },
      },
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.run('test', options)) { /* consume */ }
    } catch {
      // spawn mock may throw
    }

    const args = getSpawnArgs();
    const configArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--config');

    // Should have command and env but no args
    expect(configArgs).toContainEqual(`mcp_servers.pruner.command=${JSON.stringify('node')}`);
    const argsConfigs = configArgs.filter((a) => a.startsWith('mcp_servers.pruner.args'));
    expect(argsConfigs).toHaveLength(0);
  });

  it('does not use url or streamable_http transport config', async () => {
    const { getSpawnArgs } = setupMockSpawn();

    const options = {
      cwd: '/work',
      mcpServers: {
        pruner: {
          command: 'node' as const,
          args: ['/path/index.js'] as readonly string[],
          env: { PRUNER_URL: 'http://localhost:8000/prune' } as Readonly<Record<string, string>>,
        },
      },
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.run('test', options)) { /* consume */ }
    } catch {
      // spawn mock may throw
    }

    const args = getSpawnArgs();
    const configArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--config');

    // No url or streamable_http config
    const urlConfigs = configArgs.filter(
      (a) => a.includes('.url=') || a.includes('streamable_http'),
    );
    expect(urlConfigs).toHaveLength(0);
  });
});
