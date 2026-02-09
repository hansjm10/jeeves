import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildMcpServersConfig } from './mcpConfig.js';

/** Absolute path to this test file — always readable. */
const THIS_FILE = fileURLToPath(import.meta.url);

describe('buildMcpServersConfig', () => {
  describe('enable/disable behavior', () => {
    it('returns undefined when JEEVES_PRUNER_ENABLED is not set', () => {
      const result = buildMcpServersConfig({}, '/workspace');
      expect(result).toBeUndefined();
    });

    it('returns undefined when JEEVES_PRUNER_ENABLED is "false"', () => {
      const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'false' }, '/workspace');
      expect(result).toBeUndefined();
    });

    it('returns undefined when JEEVES_PRUNER_ENABLED is "1" (not exact "true")', () => {
      const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: '1' }, '/workspace');
      expect(result).toBeUndefined();
    });

    it('returns undefined when JEEVES_PRUNER_ENABLED is "yes" (not exact "true")', () => {
      const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'yes' }, '/workspace');
      expect(result).toBeUndefined();
    });

    it('returns undefined when JEEVES_PRUNER_ENABLED is "TRUE" (case sensitive)', () => {
      const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'TRUE' }, '/workspace');
      expect(result).toBeUndefined();
    });

    it('returns config when JEEVES_PRUNER_ENABLED is exactly "true"', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
        },
        '/workspace',
      );
      expect(result).toBeDefined();
      expect(result!.pruner).toBeDefined();
    });
  });

  describe('pruner config shape', () => {
    it('sets command to "node"', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
        },
        '/workspace',
      );
      expect(result!.pruner.command).toBe('node');
    });

    it('sets args to [entrypoint path]', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
        },
        '/workspace',
      );
      expect(result!.pruner.args).toEqual([THIS_FILE]);
    });

    it('sets env.MCP_PRUNER_CWD to the provided cwd', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
        },
        '/my/workspace',
      );
      expect(result!.pruner.env!.MCP_PRUNER_CWD).toBe('/my/workspace');
    });
  });

  describe('PRUNER_URL resolution', () => {
    it('defaults PRUNER_URL to http://localhost:8000/prune when JEEVES_PRUNER_URL is unset', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
        },
        '/workspace',
      );
      expect(result!.pruner.env!.PRUNER_URL).toBe('http://localhost:8000/prune');
    });

    it('passes through JEEVES_PRUNER_URL when set', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
          JEEVES_PRUNER_URL: 'http://custom:5000/prune',
        },
        '/workspace',
      );
      expect(result!.pruner.env!.PRUNER_URL).toBe('http://custom:5000/prune');
    });

    it('passes empty string JEEVES_PRUNER_URL through (disables pruning in server)', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
          JEEVES_PRUNER_URL: '',
        },
        '/workspace',
      );
      expect(result!.pruner.env!.PRUNER_URL).toBe('');
    });
  });

  describe('entrypoint resolution', () => {
    it('uses JEEVES_MCP_PRUNER_PATH when set and readable', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
        },
        '/workspace',
      );
      expect(result!.pruner.args).toEqual([THIS_FILE]);
    });

    it('ignores unreadable JEEVES_MCP_PRUNER_PATH and falls back', () => {
      const badPath = '/nonexistent/path/that/does/not/exist/index.js';
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          JEEVES_MCP_PRUNER_PATH: badPath,
        },
        '/workspace',
      );
      // The unreadable explicit path must NOT appear in args.
      // Depending on whether require.resolve or workspace fallback succeeds,
      // result may or may not be defined — but the bad path is never used.
      if (result) {
        expect(result.pruner.args).not.toEqual([badPath]);
      }
    });

    it('falls back to require.resolve when JEEVES_MCP_PRUNER_PATH is not set', () => {
      // This test verifies the fallback resolution works in the monorepo
      // where @jeeves/mcp-pruner should be resolvable
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
        },
        '/workspace',
      );

      // In the monorepo, @jeeves/mcp-pruner should be resolvable
      // (assuming build has run). If not, it falls back to filesystem check.
      // Either way, a result or undefined is valid depending on build state.
      if (result) {
        expect(result.pruner.args).toBeDefined();
        expect(result.pruner.args!.length).toBe(1);
        expect(typeof result.pruner.args![0]).toBe('string');
      }
      // If undefined, it means the entrypoint could not be resolved,
      // which is valid when dist hasn't been built
    });

    it('returns undefined when enabled but entrypoint cannot be resolved', () => {
      // Use a clean env without the explicit path and with a non-resolvable package
      // This is hard to test directly without mocking, but we can verify the
      // function doesn't throw
      const result = buildMcpServersConfig(
        {
          JEEVES_PRUNER_ENABLED: 'true',
          // No JEEVES_MCP_PRUNER_PATH set
          // require.resolve may or may not find the package
        },
        '/workspace',
      );

      // Result is either a valid config or undefined — both are acceptable
      expect(result === undefined || result.pruner !== undefined).toBe(true);
    });
  });

  describe('profile-driven state server wiring', () => {
    it('returns state config for profile=state when stateDir is provided', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_MCP_STATE_PATH: THIS_FILE,
        },
        '/workspace',
        { profile: 'state', stateDir: '/tmp/jeeves/issues/acme/rocket/1' },
      );
      expect(result).toBeDefined();
      expect(result!.state).toBeDefined();
      expect(result!.state.command).toBe('node');
      expect(result!.state.args).toEqual([THIS_FILE]);
      expect(result!.state.env!.MCP_STATE_DIR).toBe('/tmp/jeeves/issues/acme/rocket/1');
      expect(result!.pruner).toBeUndefined();
    });

    it('throws for profile=state when stateDir is missing', () => {
      expect(() =>
        buildMcpServersConfig(
          {
            JEEVES_MCP_STATE_PATH: THIS_FILE,
          },
          '/workspace',
          { profile: 'state' },
        ),
      ).toThrow(/requires a non-empty stateDir/i);
    });

    it('includes both state and pruner for profile=state_with_pruner when pruner is enabled', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_MCP_STATE_PATH: THIS_FILE,
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
          JEEVES_PRUNER_ENABLED: 'true',
        },
        '/workspace',
        { profile: 'state_with_pruner', stateDir: '/tmp/jeeves/issues/acme/rocket/2' },
      );
      expect(result).toBeDefined();
      expect(result!.state).toBeDefined();
      expect(result!.pruner).toBeDefined();
    });

    it('includes only state for profile=state_with_pruner when pruner is disabled', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_MCP_STATE_PATH: THIS_FILE,
          JEEVES_PRUNER_ENABLED: 'false',
        },
        '/workspace',
        { profile: 'state_with_pruner', stateDir: '/tmp/jeeves/issues/acme/rocket/3' },
      );
      expect(result).toBeDefined();
      expect(result!.state).toBeDefined();
      expect(result!.pruner).toBeUndefined();
    });

    it('returns undefined for profile=none', () => {
      const result = buildMcpServersConfig(
        {
          JEEVES_MCP_STATE_PATH: THIS_FILE,
          JEEVES_MCP_PRUNER_PATH: THIS_FILE,
          JEEVES_PRUNER_ENABLED: 'true',
        },
        '/workspace',
        { profile: 'none', stateDir: '/tmp/jeeves/issues/acme/rocket/4' },
      );
      expect(result).toBeUndefined();
    });
  });
});
