import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBash } from './bash.js';
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

describe('handleBash', () => {
  beforeEach(() => {
    vi.mocked(pruneContent).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Output formatting
  // -------------------------------------------------------------------------

  it('returns stdout on successful command (exit code 0)', async () => {
    const result = await handleBash({ command: 'echo hello' }, '/tmp', disabledConfig);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('hello');
  });

  it('appends stderr block when stderr is non-empty', async () => {
    const result = await handleBash(
      { command: 'echo out && echo err >&2' },
      '/tmp',
      disabledConfig,
    );

    expect(result.content[0].text).toContain('out');
    expect(result.content[0].text).toContain('\n[stderr]\n');
    expect(result.content[0].text).toContain('err');
  });

  it('appends exit code when exit code is non-zero', async () => {
    const result = await handleBash({ command: 'exit 42' }, '/tmp', disabledConfig);

    expect(result.content[0].text).toContain('\n[exit code: 42]');
  });

  it('returns "(no output)" when command produces no output and exits 0', async () => {
    const result = await handleBash({ command: 'true' }, '/tmp', disabledConfig);

    expect(result.content[0].text).toBe('(no output)');
  });

  it('returns "Error executing command: <message>" on spawn failure', async () => {
    // Use a command that will fail at spawn level by providing a non-existent shell
    // Note: We test via an impossible-to-spawn scenario. /bin/sh -c always works,
    // so we use a more indirect test. We know the handler catches spawn errors.
    // For reliability, test with a command that outputs correctly.
    // The actual spawn error path is covered by the catch block.
    // Let's use a directory that doesn't exist as cwd to trigger an error.
    const result = await handleBash(
      { command: 'echo test' },
      '/nonexistent_directory_12345',
      disabledConfig,
    );

    expect(result.content[0].text).toMatch(/^Error executing command: /);
  });

  it('never sets result.isError', async () => {
    const result = await handleBash({ command: 'false' }, '/tmp', disabledConfig);

    expect(Object.keys(result)).toEqual(['content']);
    expect(result).not.toHaveProperty('isError');
  });

  it('formats stdout + stderr + exit code together', async () => {
    const result = await handleBash(
      { command: 'echo out && echo err >&2 && exit 1' },
      '/tmp',
      disabledConfig,
    );

    const text = result.content[0].text;
    expect(text).toContain('out');
    expect(text).toContain('\n[stderr]\n');
    expect(text).toContain('err');
    expect(text).toContain('\n[exit code: 1]');
  });

  // -------------------------------------------------------------------------
  // Pruning behavior
  // -------------------------------------------------------------------------

  it('attempts pruning when context_focus_question is provided and pruning is enabled', async () => {
    vi.mocked(pruneContent).mockResolvedValue('pruned output');

    const result = await handleBash(
      { command: 'echo hello', context_focus_question: 'what is this?' },
      '/tmp',
      enabledConfig,
    );

    expect(pruneContent).toHaveBeenCalledWith(
      expect.stringContaining('hello'),
      'what is this?',
      enabledConfig,
    );
    expect(result.content[0].text).toBe('pruned output');
  });

  it('does not prune when context_focus_question is absent', async () => {
    await handleBash({ command: 'echo hello' }, '/tmp', enabledConfig);

    expect(pruneContent).not.toHaveBeenCalled();
  });

  it('does not prune when pruning is disabled', async () => {
    await handleBash(
      { command: 'echo hello', context_focus_question: 'question' },
      '/tmp',
      disabledConfig,
    );

    expect(pruneContent).not.toHaveBeenCalled();
  });

  it('does not prune "(no output)" placeholder', async () => {
    await handleBash(
      { command: 'true', context_focus_question: 'question' },
      '/tmp',
      enabledConfig,
    );

    expect(pruneContent).not.toHaveBeenCalled();
  });

  it('does not prune spawn error strings', async () => {
    await handleBash(
      { command: 'echo test', context_focus_question: 'question' },
      '/nonexistent_directory_12345',
      enabledConfig,
    );

    expect(pruneContent).not.toHaveBeenCalled();
  });

  it('passes query verbatim to pruneContent', async () => {
    vi.mocked(pruneContent).mockResolvedValue('pruned');

    const question = '  spaces & special! ';
    await handleBash(
      { command: 'echo test', context_focus_question: question },
      '/tmp',
      enabledConfig,
    );

    expect(pruneContent).toHaveBeenCalledWith(
      expect.any(String),
      question, // not trimmed
      enabledConfig,
    );
  });

  // -------------------------------------------------------------------------
  // Result shape
  // -------------------------------------------------------------------------

  it('returns { content: [{ type: "text", text }] } shape', async () => {
    const result = await handleBash({ command: 'echo test' }, '/tmp', disabledConfig);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.any(String) }),
    );
  });
});
