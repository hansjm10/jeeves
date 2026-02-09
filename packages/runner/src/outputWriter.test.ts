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
      response_text: 'ok',
      response_truncated: false,
      isError: true,
      durationMs: 123,
      timestamp: '2026-01-01T00:00:01.000Z',
    });

    const snap = writer.snapshot();
    expect(snap.tool_calls).toHaveLength(1);
    expect(snap.tool_calls[0]?.tool_use_id).toBe('t1');
    expect(snap.tool_calls[0]?.duration_ms).toBe(123);
    expect(snap.tool_calls[0]?.is_error).toBe(true);
    expect(snap.tool_calls[0]?.response_text).toBe('ok');
    expect(snap.tool_calls[0]?.response_truncated).toBe(false);
  });

  it('includes usage data in snapshot stats', async () => {
    const tmp = await makeTempDir('jeeves-output-writer-');
    const outputPath = path.join(tmp, 'sdk-output.json');

    const writer = new SdkOutputWriterV1({ outputPath });

    writer.addProviderEvent({
      type: 'usage',
      usage: {
        input_tokens: 50000,
        output_tokens: 8000,
        cache_read_input_tokens: 12000,
        cache_creation_input_tokens: 3000,
        total_cost_usd: 0.42,
        num_turns: 5,
      },
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const snap = writer.snapshot();
    expect(snap.stats.input_tokens).toBe(50000);
    expect(snap.stats.output_tokens).toBe(8000);
    expect(snap.stats.cache_read_input_tokens).toBe(12000);
    expect(snap.stats.cache_creation_input_tokens).toBe(3000);
    expect(snap.stats.total_cost_usd).toBe(0.42);
    expect(snap.stats.num_turns).toBe(5);
  });

  it('omits usage fields from stats when no usage event received', async () => {
    const tmp = await makeTempDir('jeeves-output-writer-');
    const outputPath = path.join(tmp, 'sdk-output.json');

    const writer = new SdkOutputWriterV1({ outputPath });

    writer.addProviderEvent({
      type: 'assistant',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const snap = writer.snapshot();
    expect(snap.stats.input_tokens).toBeUndefined();
    expect(snap.stats.output_tokens).toBeUndefined();
    expect(snap.stats.total_cost_usd).toBeUndefined();
  });

  it('includes null total_cost_usd when usage provides null', async () => {
    const tmp = await makeTempDir('jeeves-output-writer-');
    const outputPath = path.join(tmp, 'sdk-output.json');

    const writer = new SdkOutputWriterV1({ outputPath });

    writer.addProviderEvent({
      type: 'usage',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        total_cost_usd: null,
        num_turns: 2,
      },
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const snap = writer.snapshot();
    expect(snap.stats.input_tokens).toBe(1000);
    expect(snap.stats.output_tokens).toBe(500);
    expect(snap.stats.total_cost_usd).toBeNull();
    expect(snap.stats.num_turns).toBe(2);
    // Optional cache fields should not be present when not provided
    expect(snap.stats.cache_read_input_tokens).toBeUndefined();
    expect(snap.stats.cache_creation_input_tokens).toBeUndefined();
  });
});
