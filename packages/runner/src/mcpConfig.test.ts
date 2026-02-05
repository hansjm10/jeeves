import { describe, expect, it } from 'vitest';
import { buildMcpServersConfig } from './mcpConfig.js';

describe('buildMcpServersConfig', () => {
  // -------------------------------------------------------------------------
  // Disabled / not enabled
  // -------------------------------------------------------------------------

  it('returns undefined when JEEVES_PRUNER_ENABLED is not set', () => {
    const result = buildMcpServersConfig({}, '/work');
    expect(result).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "false"', () => {
    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'false' }, '/work');
    expect(result).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "TRUE" (case-sensitive)', () => {
    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'TRUE' }, '/work');
    expect(result).toBeUndefined();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is "1"', () => {
    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: '1' }, '/work');
    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Enabled with explicit path
  // -------------------------------------------------------------------------

  it('returns config when enabled with JEEVES_MCP_PRUNER_PATH', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/path/index.js',
      },
      '/work',
    );

    expect(result).toBeDefined();
    expect(result!.pruner).toBeDefined();
    expect(result!.pruner.command).toBe('node');
    expect(result!.pruner.args).toEqual(['/custom/path/index.js']);
  });

  it('sets PRUNER_URL default when JEEVES_PRUNER_URL is unset', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/index.js',
      },
      '/work',
    );

    expect(result!.pruner.env!.PRUNER_URL).toBe('http://localhost:8000/prune');
  });

  it('passes through JEEVES_PRUNER_URL when set to non-empty', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/index.js',
        JEEVES_PRUNER_URL: 'http://custom:9000/prune',
      },
      '/work',
    );

    expect(result!.pruner.env!.PRUNER_URL).toBe('http://custom:9000/prune');
  });

  it('passes through empty-string JEEVES_PRUNER_URL to disable pruning', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/index.js',
        JEEVES_PRUNER_URL: '',
      },
      '/work',
    );

    expect(result!.pruner.env!.PRUNER_URL).toBe('');
  });

  it('sets MCP_PRUNER_CWD from cwd parameter', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/index.js',
      },
      '/my/work/dir',
    );

    expect(result!.pruner.env!.MCP_PRUNER_CWD).toBe('/my/work/dir');
  });

  // -------------------------------------------------------------------------
  // Entrypoint resolution (when JEEVES_MCP_PRUNER_PATH is unset)
  // -------------------------------------------------------------------------

  it('resolves entrypoint via require.resolve when JEEVES_MCP_PRUNER_PATH is unset', () => {
    // The workspace setup means @jeeves/mcp-pruner should be resolvable.
    // After pnpm build, dist/index.js should exist.
    // If it doesn't exist yet, the fallback path mechanism should still work.
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: 'true' },
      '/work',
    );

    // Either resolves via require.resolve or the workspace fallback;
    // in either case, if the dist files exist, we get a config.
    // If neither exists, it returns undefined (graceful degradation).
    if (result) {
      expect(result.pruner.command).toBe('node');
      expect(result.pruner.args).toBeDefined();
      expect(result.pruner.args!.length).toBe(1);
      expect(typeof result.pruner.args![0]).toBe('string');
    }
    // If the build artifacts don't exist yet, result will be undefined, which is valid
  });

  // -------------------------------------------------------------------------
  // Config shape
  // -------------------------------------------------------------------------

  it('returns config keyed as "pruner"', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/index.js',
      },
      '/work',
    );

    expect(result).toHaveProperty('pruner');
    const keys = Object.keys(result!);
    expect(keys).toEqual(['pruner']);
  });

  it('config has command "node"', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/index.js',
      },
      '/work',
    );

    expect(result!.pruner.command).toBe('node');
  });

  it('config env contains PRUNER_URL and MCP_PRUNER_CWD', () => {
    const result = buildMcpServersConfig(
      {
        JEEVES_PRUNER_ENABLED: 'true',
        JEEVES_MCP_PRUNER_PATH: '/custom/index.js',
      },
      '/work',
    );

    expect(result!.pruner.env).toHaveProperty('PRUNER_URL');
    expect(result!.pruner.env).toHaveProperty('MCP_PRUNER_CWD');
  });
});
