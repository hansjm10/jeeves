import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SdkOutputWriterV1 } from './outputWriter.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('SdkOutputWriterV1', () => {
  it('updates tool_calls entry on tool_result', async () => {
    const tmp = await makeTempDir('jeeves-output-writer-');
    const outputPath = path.join(tmp, 'sdk-output.json');

    const writer = new SdkOutputWriterV1({ outputPath });

    writer.addProviderEvent({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'echo hi' },
      id: 't1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    writer.addProviderEvent({
      type: 'tool_result',
      toolUseId: 't1',
      content: 'ok',
      isError: true,
      durationMs: 123,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    const snap = writer.snapshot();
    expect(snap.tool_calls).toHaveLength(1);
    expect(snap.tool_calls[0]?.tool_use_id).toBe('t1');
    expect(snap.tool_calls[0]?.duration_ms).toBe(123);
    expect(snap.tool_calls[0]?.is_error).toBe(true);
  });
});

