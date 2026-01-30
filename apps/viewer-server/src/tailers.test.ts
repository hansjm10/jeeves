import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { LogTailer } from './tailers.js';

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

