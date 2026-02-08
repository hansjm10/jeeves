import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleGrep } from './grep.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-grep-test-'));
  // Create test files
  await fs.writeFile(path.join(tmpDir, 'match.txt'), 'hello world\nfoo bar\nhello again\n', 'utf-8');
  await fs.writeFile(path.join(tmpDir, 'nomatch.txt'), 'nothing here\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('grep tool', () => {
  describe('successful matches (exit code 0)', () => {
    it('returns stdout verbatim when matches are found', async () => {
      // Set MCP_PRUNER_CWD for grep handler
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({ pattern: 'hello', path: '.' });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('hello');
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });

    it('supports alternation regex patterns like "foo|hello"', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({ pattern: 'foo|hello', path: 'match.txt' });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('hello world');
        expect(result.content[0].text).toContain('foo bar');
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });
  });

  describe('no matches (exit code 1)', () => {
    it('returns "(no matches found)" when no matches', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({ pattern: 'zzz_nonexistent_pattern_zzz' });

        expect(result.content[0].text).toBe('(no matches found)');
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });
  });

  describe('exit code 2 handling', () => {
    it('returns "Error: <stderr>" when exit code 2 and stderr is non-empty', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        // Searching a non-existent directory triggers exit code 2 with stderr
        const result = await handleGrep({
          pattern: 'hello',
          path: '/nonexistent_dir_for_grep_test',
        });

        expect(result.content[0].text).toMatch(/^Error: /);
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });
  });

  describe('default path', () => {
    it('defaults path to "." when not specified', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({ pattern: 'hello' });

        // Should find matches in the temp dir
        expect(result.content[0].text).toContain('hello');
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });
  });

  describe('result shape', () => {
    it('returns { content: [{ type: "text", text }] } without isError', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({ pattern: 'hello' });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(typeof result.content[0].text).toBe('string');
        expect((result as Record<string, unknown>)['isError']).toBeUndefined();
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });

    it('does not set isError even for errors', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({
          pattern: 'test',
          path: '/nonexistent_dir_for_grep_test',
        });

        expect((result as Record<string, unknown>)['isError']).toBeUndefined();
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });
  });

  describe('pruning behavior', () => {
    it('does not prune when context_focus_question is absent', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({ pattern: 'hello' });

        // Without context_focus_question, raw output is returned
        expect(result.content[0].text).toContain('hello');
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });

    it('does not prune "(no matches found)"', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({
          pattern: 'zzz_nonexistent_zzz',
          context_focus_question: 'what matches?',
        });

        expect(result.content[0].text).toBe('(no matches found)');
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });
  });

  describe('node fallback behavior', () => {
    it('falls back to built-in search when grep binary is unavailable', async () => {
      const result = await handleGrep(
        { pattern: 'hello', path: tmpDir },
        { grepCommand: null },
      );

      expect(result.content[0].text).toContain('hello world');
      expect(result.content[0].text).toMatch(/\d+.*hello world/);
    });

    it('returns Error: ... for invalid regex in fallback mode', async () => {
      const result = await handleGrep(
        { pattern: '([', path: tmpDir },
        { grepCommand: null },
      );

      expect(result.content[0].text).toMatch(/^Error: /);
    });
  });

  describe('command execution', () => {
    it('runs grep -Ern --color=never <pattern> <path>', async () => {
      const origCwd = process.env.MCP_PRUNER_CWD;
      process.env.MCP_PRUNER_CWD = tmpDir;

      try {
        const result = await handleGrep({ pattern: 'hello', path: 'match.txt' });

        // grep -Ern outputs line numbers (format may be "file:N:line" or "N:line")
        expect(result.content[0].text).toContain('hello world');
        // Line numbers should be present in the output
        expect(result.content[0].text).toMatch(/\d+.*hello world/);
      } finally {
        if (origCwd !== undefined) {
          process.env.MCP_PRUNER_CWD = origCwd;
        } else {
          delete process.env.MCP_PRUNER_CWD;
        }
      }
    });
  });
});
