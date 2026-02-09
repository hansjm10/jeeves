import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { LogTailer, SdkOutputTailer } from './tailers.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('LogTailer', () => {
  it('resets its offset when the log file is truncated', async () => {
    const dir = await makeTempDir('jeeves-vs-logtailer-');
    const filePath = path.join(dir, 'last-run.log');
    await fs.writeFile(filePath, 'a\nb\n', 'utf-8');

    const tailer = new LogTailer();
    tailer.reset(filePath);

    const first = await tailer.getNewLines();
    expect(first.lines).toEqual(['a', 'b']);

    await fs.appendFile(filePath, 'c\n', 'utf-8');
    const second = await tailer.getNewLines();
    expect(second.lines).toEqual(['c']);

    await fs.writeFile(filePath, 'x\ny\n', 'utf-8');
    const afterTruncate = await tailer.getNewLines();
    expect(afterTruncate.lines).toEqual(['x', 'y']);
  });
});

describe('SdkOutputTailer', () => {
  it('emits tool completion with response metadata', () => {
    const tailer = new SdkOutputTailer();
    tailer.reset(null);

    const diff = tailer.consumeAndDiff({
      session_id: 'session-1',
      messages: [],
      tool_calls: [
        {
          tool_use_id: 'tool-1',
          name: 'mcp:pruner/read',
          input: { file_path: 'src/a.ts' },
          duration_ms: 42,
          is_error: false,
          response_text: '{"ok":true}',
          response_truncated: false,
        },
      ],
      stats: {},
    });

    expect(diff.toolStarts).toEqual([
      {
        tool_use_id: 'tool-1',
        name: 'mcp:pruner/read',
        input: { file_path: 'src/a.ts' },
      },
    ]);
    expect(diff.toolCompletes).toEqual([
      {
        tool_use_id: 'tool-1',
        name: 'mcp:pruner/read',
        duration_ms: 42,
        is_error: false,
        response_text: '{"ok":true}',
        response_truncated: false,
      },
    ]);
  });

  it('remains compatible when response metadata is absent', () => {
    const tailer = new SdkOutputTailer();
    tailer.reset(null);

    const diff = tailer.consumeAndDiff({
      session_id: 'session-1',
      messages: [],
      tool_calls: [
        {
          tool_use_id: 'tool-legacy',
          name: 'command_execution',
          input: { command: 'echo hi' },
          duration_ms: 10,
          is_error: false,
        },
      ],
      stats: {},
    });

    expect(diff.toolCompletes).toEqual([
      {
        tool_use_id: 'tool-legacy',
        name: 'command_execution',
        duration_ms: 10,
        is_error: false,
        response_text: undefined,
        response_truncated: undefined,
      },
    ]);
  });
});
