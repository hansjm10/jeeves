import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { handleRead, type ReadToolDeps } from './read.js';
import type { PrunerConfig } from '../pruner.js';

// Mock the pruner module
vi.mock('../pruner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pruner.js')>();
  return {
    ...actual,
    pruneContent: vi.fn(),
  };
});

import { pruneContent } from '../pruner.js';

const enabledConfig: PrunerConfig = {
  url: 'http://localhost:8000/prune',
  timeoutMs: 5000,
  enabled: true,
};

const disabledConfig: PrunerConfig = {
  url: '',
  timeoutMs: 5000,
  enabled: false,
};

describe('handleRead', () => {
  beforeEach(() => {
    vi.mocked(pruneContent).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Path resolution
  // -------------------------------------------------------------------------

  it('reads absolute file_path as-is', async () => {
    // Use this test file itself as the target
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/nonexistent', prunerConfig: disabledConfig };

    const result = await handleRead({ file_path: absPath }, deps);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('handleRead');
  });

  it('resolves relative file_path against cwd', async () => {
    const deps: ReadToolDeps = { cwd: path.resolve(__dirname, '..'), prunerConfig: disabledConfig };

    const result = await handleRead({ file_path: 'tools/read.ts' }, deps);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('handleRead');
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('returns "Error reading file: <message>" on file not found', async () => {
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: disabledConfig };

    const result = await handleRead({ file_path: '/nonexistent/path/file.txt' }, deps);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toMatch(/^Error reading file: /);
    // Verify no isError property is set on result
    expect(result).not.toHaveProperty('isError');
  });

  it('never sets result.isError on read errors', async () => {
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: disabledConfig };

    const result = await handleRead({ file_path: '/nonexistent' }, deps);

    // The result should only have content, no isError
    expect(Object.keys(result)).toEqual(['content']);
  });

  // -------------------------------------------------------------------------
  // Output formatting
  // -------------------------------------------------------------------------

  it('returns raw file contents on success', async () => {
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: disabledConfig };

    const result = await handleRead({ file_path: absPath }, deps);

    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('returns { content: [{ type: "text", text }] } shape', async () => {
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: disabledConfig };

    const result = await handleRead({ file_path: absPath }, deps);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.any(String) }),
    );
  });

  // -------------------------------------------------------------------------
  // Pruning behavior
  // -------------------------------------------------------------------------

  it('attempts pruning when context_focus_question is provided and pruning is enabled', async () => {
    vi.mocked(pruneContent).mockResolvedValue('pruned result');
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: enabledConfig };

    const result = await handleRead(
      { file_path: absPath, context_focus_question: 'what does this do?' },
      deps,
    );

    expect(pruneContent).toHaveBeenCalledWith(
      expect.any(String), // file contents
      'what does this do?', // query passed verbatim
      enabledConfig,
    );
    expect(result.content[0].text).toBe('pruned result');
  });

  it('does not prune when context_focus_question is absent', async () => {
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: enabledConfig };

    await handleRead({ file_path: absPath }, deps);

    expect(pruneContent).not.toHaveBeenCalled();
  });

  it('does not prune when pruning is disabled', async () => {
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: disabledConfig };

    await handleRead(
      { file_path: absPath, context_focus_question: 'question' },
      deps,
    );

    expect(pruneContent).not.toHaveBeenCalled();
  });

  it('does not attempt pruning for error strings (file read failure)', async () => {
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: enabledConfig };

    const result = await handleRead(
      { file_path: '/nonexistent', context_focus_question: 'question' },
      deps,
    );

    expect(pruneContent).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/^Error reading file: /);
  });

  it('falls back to unpruned output on pruner failure', async () => {
    vi.mocked(pruneContent).mockImplementation(async (code: string) => code);
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: enabledConfig };

    const result = await handleRead(
      { file_path: absPath, context_focus_question: 'question' },
      deps,
    );

    // pruneContent falls back to returning original content
    expect(result.content[0].text).toContain('handleRead');
  });

  it('passes context_focus_question verbatim as query', async () => {
    vi.mocked(pruneContent).mockResolvedValue('pruned');
    const absPath = path.resolve(__dirname, 'read.ts');
    const deps: ReadToolDeps = { cwd: '/tmp', prunerConfig: enabledConfig };

    const question = '  spaces and special chars! @#$ ';
    await handleRead(
      { file_path: absPath, context_focus_question: question },
      deps,
    );

    expect(pruneContent).toHaveBeenCalledWith(
      expect.any(String),
      question, // not trimmed
      enabledConfig,
    );
  });
});
