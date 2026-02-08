import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PrunerConfig } from '../pruner.js';
import { handleBash } from './bash.js';

function disabledPruner(): PrunerConfig {
  return { url: '', timeoutMs: 30_000, enabled: false };
}

function enabledPruner(): PrunerConfig {
  return { url: 'http://localhost:9999/prune', timeoutMs: 30_000, enabled: true };
}

describe('bash tool', () => {
  describe('output formatting', () => {
    it('returns stdout for successful command', async () => {
      const result = await handleBash(
        { command: 'echo hello' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe('hello\n');
    });

    it('appends stderr when present', async () => {
      const result = await handleBash(
        { command: 'echo out && echo err >&2' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result.content[0].text).toContain('out\n');
      expect(result.content[0].text).toContain('\n[stderr]\nerr\n');
    });

    it('appends exit code when non-zero', async () => {
      const result = await handleBash(
        { command: 'exit 42' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result.content[0].text).toContain('[exit code: 42]');
    });

    it('formats combined stdout + stderr + exit code correctly', async () => {
      const result = await handleBash(
        { command: 'echo out && echo err >&2 && exit 1' },
        process.cwd(),
        disabledPruner(),
      );

      const text = result.content[0].text;
      expect(text).toContain('out\n');
      expect(text).toContain('\n[stderr]\nerr\n');
      expect(text).toContain('\n[exit code: 1]');
    });

    it('returns "(no output)" when command produces no output with exit 0', async () => {
      const result = await handleBash(
        { command: 'true' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result.content[0].text).toBe('(no output)');
    });

    it('returns shell resolution error as "Error executing command: <message>"', async () => {
      const result = await handleBash(
        { command: 'echo hi' },
        process.cwd(),
        disabledPruner(),
        {
          platform: 'win32',
          pathLookup: () =>
            ({
              status: 1,
              stdout: '',
              stderr: '',
              output: [],
              pid: 1,
              signal: null,
            }) as unknown as import('node:child_process').SpawnSyncReturns<string>,
          fileExists: () => false,
        },
      );

      expect(result.content[0].text).toContain('Error executing command:');
      expect(result.content[0].text).toContain('No usable bash-compatible shell found');
    });
  });

  describe('result shape', () => {
    it('returns { content: [{ type: "text", text }] } without isError', async () => {
      const result = await handleBash(
        { command: 'echo test' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result).toEqual({
        content: [{ type: 'text', text: 'test\n' }],
      });
      expect((result as Record<string, unknown>)['isError']).toBeUndefined();
    });

    it('does not set isError even on command failure', async () => {
      const result = await handleBash(
        { command: 'exit 1' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result).toEqual({
        content: [{ type: 'text', text: expect.stringContaining('[exit code: 1]') }],
      });
      expect((result as Record<string, unknown>)['isError']).toBeUndefined();
    });
  });

  describe('pruning behavior', () => {
    it('does not prune when context_focus_question is absent', async () => {
      const result = await handleBash(
        { command: 'echo raw output' },
        process.cwd(),
        enabledPruner(),
      );

      expect(result.content[0].text).toBe('raw output\n');
    });

    it('does not prune when pruning is disabled', async () => {
      const result = await handleBash(
        { command: 'echo raw output', context_focus_question: 'what?' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result.content[0].text).toBe('raw output\n');
    });

    it('does not prune "(no output)" output', async () => {
      const result = await handleBash(
        { command: 'true', context_focus_question: 'what?' },
        process.cwd(),
        disabledPruner(),
      );

      expect(result.content[0].text).toBe('(no output)');
    });
  });

  describe('signal-terminated commands', () => {
    it('formats signal-terminated process as normal output with null exit code', async () => {
      // Send SIGTERM to the shell process itself. The shell should be killed
      // by the signal, and the output should be formatted as a command
      // completion (not a spawn error).
      const result = await handleBash(
        { command: 'kill -TERM $$' },
        process.cwd(),
        disabledPruner(),
      );

      const text = result.content[0].text;
      // Should show exit code (null for signal) rather than "Error executing command:"
      expect(text).toContain('[exit code:');
      expect(text).not.toContain('Error executing command:');
    });

    it('does not set isError for signal-terminated commands', async () => {
      const result = await handleBash(
        { command: 'kill -TERM $$' },
        process.cwd(),
        disabledPruner(),
      );

      expect((result as Record<string, unknown>)['isError']).toBeUndefined();
    });
  });

  describe('working directory', () => {
    it('executes command in the specified cwd', async () => {
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-bash-cwd-'));
      const result = await handleBash(
        { command: 'pwd' },
        tempDir,
        disabledPruner(),
      );

      expect(result.content[0].text.trim()).toBeTruthy();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });
  });
});
