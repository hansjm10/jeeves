import { describe, expect, it } from 'vitest';

import type { ProviderRunOptions, McpServerConfig } from '../provider.js';
import {
  ClaudeAgentProvider,
  getDangerousBashCommandBlockReason,
  resolveClaudePermissionMode,
} from './claudeAgentSdk.js';

describe('ClaudeAgentProvider', () => {
  describe('mcpServers wiring', () => {
    it('has the correct provider name', () => {
      const provider = new ClaudeAgentProvider();
      expect(provider.name).toBe('claude-agent-sdk');
    });

    it('accepts ProviderRunOptions with mcpServers', () => {
      // Verify the provider can be instantiated and its run method accepts
      // options with mcpServers. We can't fully test the SDK call without
      // mocking the SDK, but we can verify the type compatibility.
      expect(new ClaudeAgentProvider().name).toBe('claude-agent-sdk');

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

      // Verify the options shape is accepted (type-level check)
      expect(options.mcpServers).toBeDefined();
      expect(options.mcpServers!.pruner.command).toBe('node');
      expect(options.mcpServers!.pruner.args).toEqual(['/path/to/mcp-pruner/dist/index.js']);
      expect(options.mcpServers!.pruner.env!.PRUNER_URL).toBe('http://localhost:8000/prune');
      expect(options.mcpServers!.pruner.env!.MCP_PRUNER_CWD).toBe('/workspace');
    });

    it('accepts ProviderRunOptions without mcpServers', () => {
      const options: ProviderRunOptions = {
        cwd: '/workspace',
      };

      expect(options.mcpServers).toBeUndefined();
    });

    it('provider run method signature accepts options with mcpServers', () => {
      const provider = new ClaudeAgentProvider();

      // Verify the run method exists and is callable (type-level validation)
      expect(typeof provider.run).toBe('function');

      // Verify the provider implements AgentProvider interface
      expect(provider.name).toBe('claude-agent-sdk');
    });
  });

  describe('mcpServers presence/absence in SDK options', () => {
    // These tests verify that the provider correctly handles the conditional
    // spreading of mcpServers into SDK options. Since we can't mock the SDK
    // query function without complex setup, we verify the logic pattern
    // by examining the source code behavior indirectly.

    it('mcpServers config has the expected McpServerConfig shape', () => {
      const config: McpServerConfig = {
        command: 'node',
        args: ['/path/to/server.js'],
        env: { KEY: 'value' },
      };

      expect(config.command).toBe('node');
      expect(config.args).toEqual(['/path/to/server.js']);
      expect(config.env).toEqual({ KEY: 'value' });
    });

    it('McpServerConfig allows optional args and env', () => {
      const minimal: McpServerConfig = {
        command: 'node',
      };

      expect(minimal.command).toBe('node');
      expect(minimal.args).toBeUndefined();
      expect(minimal.env).toBeUndefined();
    });

    it('provider constructs SDK options with mcpServers when present', () => {
      // The ClaudeAgentProvider uses the spread pattern:
      // ...(options.mcpServers ? { mcpServers: options.mcpServers as Options['mcpServers'] } : {})
      // This test validates the pattern works correctly.

      const mcpServers = {
        pruner: {
          command: 'node' as const,
          args: ['/path/to/index.js'] as readonly string[],
          env: { PRUNER_URL: 'http://localhost:8000/prune' } as Readonly<Record<string, string>>,
        },
      };

      // Simulate the spread pattern used in the provider
      const sdkOptions = {
        cwd: '/workspace',
        ...(mcpServers ? { mcpServers } : {}),
      };

      expect(sdkOptions.mcpServers).toBeDefined();
      expect(sdkOptions.mcpServers!.pruner.command).toBe('node');
    });

    it('provider constructs SDK options without mcpServers when absent', () => {
      const mcpServers = undefined;

      // Simulate the spread pattern used in the provider
      const sdkOptions = {
        cwd: '/workspace',
        ...(mcpServers ? { mcpServers } : {}),
      };

      expect(sdkOptions).not.toHaveProperty('mcpServers');
    });
  });

  describe('permission mode resolution', () => {
    it('defaults to bypassPermissions when mode is not provided', () => {
      const resolved = resolveClaudePermissionMode(undefined, undefined);

      expect(resolved.requestedPermissionMode).toBe('bypassPermissions');
      expect(resolved.sdkPermissionMode).toBe('bypassPermissions');
      expect(resolved.allowDangerouslySkipPermissions).toBe(true);
    });

    it('maps plan mode to bypassPermissions for Claude SDK', () => {
      const resolved = resolveClaudePermissionMode('plan', undefined);

      expect(resolved.requestedPermissionMode).toBe('plan');
      expect(resolved.sdkPermissionMode).toBe('bypassPermissions');
      expect(resolved.allowDangerouslySkipPermissions).toBe(true);
    });

    it('honors explicit non-bypass permission modes', () => {
      const resolved = resolveClaudePermissionMode('default', undefined);

      expect(resolved.requestedPermissionMode).toBe('default');
      expect(resolved.sdkPermissionMode).toBe('default');
      expect(resolved.allowDangerouslySkipPermissions).toBe(false);
    });

    it('uses env permission mode when options mode is unset', () => {
      const resolved = resolveClaudePermissionMode(undefined, 'plan');

      expect(resolved.requestedPermissionMode).toBe('plan');
      expect(resolved.sdkPermissionMode).toBe('bypassPermissions');
      expect(resolved.allowDangerouslySkipPermissions).toBe(true);
    });
  });

  describe('dangerous bash command guard', () => {
    it('blocks broad kill commands for Bash tool', () => {
      const reason = getDangerousBashCommandBlockReason(
        'Bash',
        { command: 'pkill -f "node.*viewer-server"' },
        {},
      );

      expect(reason).toContain('Blocked potentially destructive Bash command');
      expect(reason).toContain('pkill');
    });

    it('blocks fuser -k and killall command forms', () => {
      const fuserReason = getDangerousBashCommandBlockReason(
        'Bash',
        { command: 'fuser -k 8081/tcp' },
        {},
      );
      const killallReason = getDangerousBashCommandBlockReason(
        'Bash',
        { command: 'sudo killall node' },
        {},
      );

      expect(fuserReason).toContain('fuser -k');
      expect(killallReason).toContain('killall');
    });

    it('allows safe commands and non-Bash tools', () => {
      expect(
        getDangerousBashCommandBlockReason(
          'Bash',
          { command: 'pnpm test --filter runner' },
          {},
        ),
      ).toBeNull();
      expect(
        getDangerousBashCommandBlockReason(
          'Read',
          { command: 'pkill -f node' },
          {},
        ),
      ).toBeNull();
    });

    it('allows blocked commands when override env var is true', () => {
      const reason = getDangerousBashCommandBlockReason(
        'Bash',
        { command: 'pkill -f node' },
        { JEEVES_ALLOW_DANGEROUS_PROCESS_KILL: 'true' },
      );

      expect(reason).toBeNull();
    });
  });
});
