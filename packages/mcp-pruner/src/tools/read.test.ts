import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PrunerConfig } from '../pruner.js';
import { handleRead, readInputSchema } from './read.js';

function disabledPruner(): PrunerConfig {
  return { url: '', timeoutMs: 30_000, enabled: false };
}

function enabledPruner(): PrunerConfig {
  return { url: 'http://localhost:9999/prune', timeoutMs: 30_000, enabled: true };
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mcp-read-test-'));
}

describe('read tool', () => {
  describe('input schema', () => {
    it('defines file_path as required string', () => {
      expect(readInputSchema.file_path).toBeDefined();
    });

    it('defines context_focus_question as optional string', () => {
      expect(readInputSchema.context_focus_question).toBeDefined();
      // The schema should accept undefined
      expect(readInputSchema.context_focus_question.isOptional()).toBe(true);
    });
  });

  describe('path resolution', () => {
    it('reads an absolute file path as-is', async () => {
      const tmp = await makeTempDir();
      const filePath = path.join(tmp, 'test.txt');
      await fs.writeFile(filePath, 'hello world', 'utf-8');

      const result = await handleRead(
        { file_path: filePath },
        { cwd: '/some/other/dir', prunerConfig: disabledPruner() },
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe('hello world');
    });

    it('resolves relative file_path against MCP_PRUNER_CWD', async () => {
      const tmp = await makeTempDir();
      const filePath = path.join(tmp, 'relative.txt');
      await fs.writeFile(filePath, 'relative content', 'utf-8');

      const result = await handleRead(
        { file_path: 'relative.txt' },
        { cwd: tmp, prunerConfig: disabledPruner() },
      );

      expect(result.content[0].text).toBe('relative content');
    });
  });

  describe('failure handling', () => {
    it('returns "Error reading file: <message>" on read failure', async () => {
      const result = await handleRead(
        { file_path: '/nonexistent/path/file.txt' },
        { cwd: '/tmp', prunerConfig: disabledPruner() },
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toMatch(/^Error reading file: /);
    });

    it('does not set isError on failure', async () => {
      const result = await handleRead(
        { file_path: '/nonexistent/path/file.txt' },
        { cwd: '/tmp', prunerConfig: disabledPruner() },
      );

      // Result should be { content: [{ type, text }] } with no isError field
      expect(result).toEqual({
        content: [{ type: 'text', text: expect.stringMatching(/^Error reading file: /) }],
      });
      expect((result as Record<string, unknown>)['isError']).toBeUndefined();
    });
  });

  describe('output format', () => {
    it('returns content as { content: [{ type: "text", text }] }', async () => {
      const tmp = await makeTempDir();
      const filePath = path.join(tmp, 'format.txt');
      await fs.writeFile(filePath, 'formatted', 'utf-8');

      const result = await handleRead(
        { file_path: filePath },
        { cwd: tmp, prunerConfig: disabledPruner() },
      );

      expect(result).toEqual({
        content: [{ type: 'text', text: 'formatted' }],
      });
    });

    it('reads empty files successfully', async () => {
      const tmp = await makeTempDir();
      const filePath = path.join(tmp, 'empty.txt');
      await fs.writeFile(filePath, '', 'utf-8');

      const result = await handleRead(
        { file_path: filePath },
        { cwd: tmp, prunerConfig: disabledPruner() },
      );

      expect(result.content[0].text).toBe('');
    });
  });

  describe('pruning behavior', () => {
    it('does not attempt pruning when context_focus_question is absent', async () => {
      const tmp = await makeTempDir();
      const filePath = path.join(tmp, 'noprune.txt');
      await fs.writeFile(filePath, 'raw content', 'utf-8');

      const result = await handleRead(
        { file_path: filePath },
        { cwd: tmp, prunerConfig: enabledPruner() },
      );

      // Without context_focus_question, raw content is returned as-is
      expect(result.content[0].text).toBe('raw content');
    });

    it('does not attempt pruning when pruning is disabled', async () => {
      const tmp = await makeTempDir();
      const filePath = path.join(tmp, 'noprune2.txt');
      await fs.writeFile(filePath, 'raw content', 'utf-8');

      const result = await handleRead(
        { file_path: filePath, context_focus_question: 'what is this?' },
        { cwd: tmp, prunerConfig: disabledPruner() },
      );

      expect(result.content[0].text).toBe('raw content');
    });

    it('does not attempt pruning for error output (file read failure)', async () => {
      // Even with pruning enabled and context_focus_question, errors are not pruned
      const result = await handleRead(
        { file_path: '/nonexistent/path.txt', context_focus_question: 'what?' },
        { cwd: '/tmp', prunerConfig: enabledPruner() },
      );

      expect(result.content[0].text).toMatch(/^Error reading file: /);
    });
  });
});
