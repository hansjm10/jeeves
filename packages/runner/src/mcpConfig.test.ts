import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock fs and createRequire for controlled path resolution
vi.mock('node:fs', () => ({
  default: {
    accessSync: vi.fn(),
    constants: { R_OK: 4 },
  },
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn(),
}));

// Dynamic import to ensure mocks are in place
async function importModule() {
  // Reset modules so mocks take effect on each fresh import
  vi.resetModules();

  // Re-mock after resetModules
  vi.doMock('node:fs', () => ({
    default: {
      accessSync: vi.fn(),
      constants: { R_OK: 4 },
    },
  }));

  vi.doMock('node:module', () => ({
    createRequire: vi.fn(),
  }));

  const mod = await import('./mcpConfig.js');
  return mod;
}

describe('buildMcpServersConfig', () => {
  let buildMcpServersConfig: Awaited<ReturnType<typeof importModule>>['buildMcpServersConfig'];

  beforeEach(async () => {
    const mod = await importModule();
    buildMcpServersConfig = mod.buildMcpServersConfig;

    // Default: require.resolve works
    const mockRequire = { resolve: vi.fn().mockReturnValue('/resolved/mcp-pruner/dist/index.js') } as unknown as NodeRequire;
    const { createRequire: cr } = await import('node:module');
    vi.mocked(cr).mockReturnValue(mockRequire);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when JEEVES_PRUNER_ENABLED is not "true"', () => {
    expect(buildMcpServersConfig({}, '/workspace')).toBeUndefined();
    expect(buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'false' }, '/workspace')).toBeUndefined();
    expect(buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'TRUE' }, '/workspace')).toBeUndefined();
    expect(buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: '1' }, '/workspace')).toBeUndefined();
    expect(buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: '' }, '/workspace')).toBeUndefined();
  });

  it('returns mcpServers.pruner when JEEVES_PRUNER_ENABLED is exactly "true"', () => {
    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'true' }, '/workspace');

    expect(result).toBeDefined();
    expect(result!.pruner).toBeDefined();
    expect(result!.pruner.command).toBe('node');
    expect(result!.pruner.args).toBeDefined();
    expect(result!.pruner.args!.length).toBe(1);
  });

  it('sets PRUNER_URL to default http://localhost:8000/prune when JEEVES_PRUNER_URL is unset', () => {
    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'true' }, '/workspace');

    expect(result!.pruner.env!.PRUNER_URL).toBe('http://localhost:8000/prune');
  });

  it('passes through JEEVES_PRUNER_URL when set', () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: 'true', JEEVES_PRUNER_URL: 'http://custom:9000/api' },
      '/workspace',
    );

    expect(result!.pruner.env!.PRUNER_URL).toBe('http://custom:9000/api');
  });

  it('passes through empty string JEEVES_PRUNER_URL (disables pruning)', () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: 'true', JEEVES_PRUNER_URL: '' },
      '/workspace',
    );

    expect(result!.pruner.env!.PRUNER_URL).toBe('');
  });

  it('sets MCP_PRUNER_CWD from the cwd parameter', () => {
    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'true' }, '/my/project');

    expect(result!.pruner.env!.MCP_PRUNER_CWD).toBe('/my/project');
  });

  it('uses JEEVES_MCP_PRUNER_PATH when explicitly set', () => {
    const result = buildMcpServersConfig(
      { JEEVES_PRUNER_ENABLED: 'true', JEEVES_MCP_PRUNER_PATH: '/custom/path/index.js' },
      '/workspace',
    );

    expect(result!.pruner.args).toEqual(['/custom/path/index.js']);
  });

  it('resolves entrypoint via require.resolve when JEEVES_MCP_PRUNER_PATH is not set', () => {
    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'true' }, '/workspace');

    expect(result!.pruner.args).toEqual(['/resolved/mcp-pruner/dist/index.js']);
  });

  it('returns undefined when entrypoint cannot be resolved and no fallback exists', async () => {
    // require.resolve throws, and fs.accessSync also throws
    const mockRequire = {
      resolve: vi.fn().mockImplementation(() => {
        throw new Error('not found');
      }),
    } as unknown as NodeRequire;
    const { createRequire: cr } = await import('node:module');
    vi.mocked(cr).mockReturnValue(mockRequire);

    const { default: mockedFsInner } = await import('node:fs');
    vi.mocked(mockedFsInner.accessSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = buildMcpServersConfig({ JEEVES_PRUNER_ENABLED: 'true' }, '/workspace');

    expect(result).toBeUndefined();
  });
});
