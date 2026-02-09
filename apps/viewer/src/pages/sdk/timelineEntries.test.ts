import { describe, expect, it } from 'vitest';

import type { SdkEvent } from '../../api/types.js';
import type { ToolState } from './useToolState.js';
import { buildTimelineEntries, entryMatchesFilter } from './timelineEntries.js';

function makeTool(overrides: Partial<ToolState> = {}): ToolState {
  return {
    tool_use_id: 'tool-1',
    name: 'mcp:pruner/read',
    input: { file_path: 'a.ts' },
    status: 'completed',
    duration_ms: 12,
    timestamp: 1,
    order: 0,
    ...overrides,
  };
}

describe('buildTimelineEntries', () => {
  it('includes user and assistant sdk-message entries in order with tools', () => {
    const events: SdkEvent[] = [
      {
        event: 'sdk-message',
        data: { message: { type: 'assistant', content: 'I will inspect files.' }, index: 0, total: 4 },
      },
      {
        event: 'sdk-tool-start',
        data: { tool_use_id: 'tool-1', name: 'mcp:pruner/read', input: { file_path: 'a.ts' } },
      },
      {
        event: 'sdk-message',
        data: { message: { type: 'user', content: 'Please check this file.' }, index: 2, total: 4 },
      },
      {
        event: 'sdk-message',
        data: { message: { type: 'tool_result', content: 'skip me' }, index: 3, total: 4 },
      },
    ];

    const entries = buildTimelineEntries(events, [makeTool()]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'message', message: { type: 'assistant', content: 'I will inspect files.' } });
    expect(entries[1]).toMatchObject({ kind: 'tool', tool: { tool_use_id: 'tool-1' } });
    expect(entries[2]).toMatchObject({ kind: 'message', message: { type: 'user', content: 'Please check this file.' } });
  });

  it('falls back to sdk-tool-complete when sdk-tool-start is missing', () => {
    const events: SdkEvent[] = [
      {
        event: 'sdk-tool-complete',
        data: { tool_use_id: 'tool-1', name: 'mcp:pruner/read', duration_ms: 99, is_error: false },
      },
    ];

    const entries = buildTimelineEntries(events, [makeTool()]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', tool: { tool_use_id: 'tool-1' } });
  });
});

describe('entryMatchesFilter', () => {
  it('matches message content and type', () => {
    const entry = {
      kind: 'message' as const,
      key: 'msg-1',
      message: { type: 'assistant' as const, content: 'Review complete', raw: { type: 'assistant' } },
    };

    expect(entryMatchesFilter(entry, 'review')).toBe(true);
    expect(entryMatchesFilter(entry, 'assistant')).toBe(true);
    expect(entryMatchesFilter(entry, 'user')).toBe(false);
  });
});
