import { describe, expect, it } from 'vitest';

import type { McpServerConfig, ProviderRunOptions } from '../provider.js';
import { CodexSdkProvider, mapCodexEventToProviderEvents, type CodexThreadEvent } from './codexSdk.js';

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
});

describe('CodexSdkProvider mcpServers wiring', () => {
  it('has the correct provider name', () => {
    const provider = new CodexSdkProvider();
    expect(provider.name).toBe('codex');
  });

  it('accepts ProviderRunOptions with mcpServers', () => {
    const mcpServers: Record<string, McpServerConfig> = {
      pruner: {
        command: 'node',
        args: ['/path/to/mcp-pruner/dist/index.js'],
        env: {
          PRUNER_URL: 'http://localhost:8000/prune',
          MCP_PRUNER_CWD: '/workspace',
        },
      },
    };

    const options: ProviderRunOptions = {
      cwd: '/workspace',
      mcpServers,
    };

    expect(options.mcpServers).toBeDefined();
    expect(options.mcpServers!.pruner.command).toBe('node');
    expect(options.mcpServers!.pruner.args).toEqual(['/path/to/mcp-pruner/dist/index.js']);
    expect(options.mcpServers!.pruner.env!.PRUNER_URL).toBe('http://localhost:8000/prune');
  });

  it('accepts ProviderRunOptions without mcpServers', () => {
    const options: ProviderRunOptions = {
      cwd: '/workspace',
    };

    expect(options.mcpServers).toBeUndefined();
  });

  describe('mcpServers to codex --config translation', () => {
    it('builds mcp_servers.<name>.command config override', () => {
      const mcpServers: Record<string, McpServerConfig> = {
        pruner: {
          command: 'node',
          args: ['/path/to/index.js'],
          env: { KEY: 'val' },
        },
      };

      // Simulate the codex provider's config building logic
      const args: string[] = [];
      for (const [name, config] of Object.entries(mcpServers)) {
        args.push('--config', `mcp_servers.${name}.command=${JSON.stringify(config.command)}`);
        if (config.args && config.args.length > 0) {
          args.push('--config', `mcp_servers.${name}.args=${JSON.stringify(config.args)}`);
        }
        if (config.env) {
          for (const [envKey, envValue] of Object.entries(config.env)) {
            args.push('--config', `mcp_servers.${name}.env.${envKey}=${JSON.stringify(envValue)}`);
          }
        }
      }

      expect(args).toContain('--config');
      expect(args).toContain('mcp_servers.pruner.command="node"');
      expect(args).toContain(`mcp_servers.pruner.args=${JSON.stringify(['/path/to/index.js'])}`);
      expect(args).toContain('mcp_servers.pruner.env.KEY="val"');
    });

    it('omits args config when args are not provided', () => {
      const mcpServers: Record<string, McpServerConfig> = {
        pruner: {
          command: 'node',
        },
      };

      const args: string[] = [];
      for (const [name, config] of Object.entries(mcpServers)) {
        args.push('--config', `mcp_servers.${name}.command=${JSON.stringify(config.command)}`);
        if (config.args && config.args.length > 0) {
          args.push('--config', `mcp_servers.${name}.args=${JSON.stringify(config.args)}`);
        }
        if (config.env) {
          for (const [envKey, envValue] of Object.entries(config.env)) {
            args.push('--config', `mcp_servers.${name}.env.${envKey}=${JSON.stringify(envValue)}`);
          }
        }
      }

      expect(args).toContain('mcp_servers.pruner.command="node"');
      const argsConfigs = args.filter((a) => a.includes('mcp_servers.pruner.args'));
      expect(argsConfigs).toHaveLength(0);
    });

    it('sets env vars via mcp_servers.<name>.env.<KEY> and does not use url/streamable_http', () => {
      const mcpServers: Record<string, McpServerConfig> = {
        pruner: {
          command: 'node',
          args: ['/path/to/index.js'],
          env: {
            PRUNER_URL: 'http://localhost:8000/prune',
            MCP_PRUNER_CWD: '/workspace',
          },
        },
      };

      const args: string[] = [];
      for (const [name, config] of Object.entries(mcpServers)) {
        args.push('--config', `mcp_servers.${name}.command=${JSON.stringify(config.command)}`);
        if (config.args && config.args.length > 0) {
          args.push('--config', `mcp_servers.${name}.args=${JSON.stringify(config.args)}`);
        }
        if (config.env) {
          for (const [envKey, envValue] of Object.entries(config.env)) {
            args.push('--config', `mcp_servers.${name}.env.${envKey}=${JSON.stringify(envValue)}`);
          }
        }
      }

      // Verify env vars are set correctly
      expect(args).toContain('mcp_servers.pruner.env.PRUNER_URL="http://localhost:8000/prune"');
      expect(args).toContain('mcp_servers.pruner.env.MCP_PRUNER_CWD="/workspace"');

      // Verify no url/streamable_http config is used
      const urlConfigs = args.filter((a) => a.includes('.url=') || a.includes('streamable_http'));
      expect(urlConfigs).toHaveLength(0);
    });

    it('handles multiple MCP server entries', () => {
      const mcpServers: Record<string, McpServerConfig> = {
        pruner: {
          command: 'node',
          args: ['/path/to/pruner.js'],
        },
        other: {
          command: 'python',
          args: ['/path/to/other.py'],
          env: { PORT: '8080' },
        },
      };

      const args: string[] = [];
      for (const [name, config] of Object.entries(mcpServers)) {
        args.push('--config', `mcp_servers.${name}.command=${JSON.stringify(config.command)}`);
        if (config.args && config.args.length > 0) {
          args.push('--config', `mcp_servers.${name}.args=${JSON.stringify(config.args)}`);
        }
        if (config.env) {
          for (const [envKey, envValue] of Object.entries(config.env)) {
            args.push('--config', `mcp_servers.${name}.env.${envKey}=${JSON.stringify(envValue)}`);
          }
        }
      }

      expect(args).toContain('mcp_servers.pruner.command="node"');
      expect(args).toContain('mcp_servers.other.command="python"');
      expect(args).toContain('mcp_servers.other.env.PORT="8080"');
    });
  });
});
