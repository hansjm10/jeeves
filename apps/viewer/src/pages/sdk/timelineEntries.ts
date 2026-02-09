import type { SdkEvent } from '../../api/types.js';
import type { ToolState } from './useToolState.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toMessage(data: unknown): TimelineMessage | null {
  if (!isRecord(data)) return null;
  const inner = data.message;
  if (!isRecord(inner)) return null;

  const type = typeof inner.type === 'string' ? inner.type : '';
  if (type !== 'user' && type !== 'assistant' && type !== 'result') return null;

  return {
    type,
    content: safeStringify(inner.content),
    raw: inner,
  };
}

export type TimelineMessage = Readonly<{
  type: 'user' | 'assistant' | 'result';
  content: string;
  raw: Record<string, unknown>;
}>;

export type TimelineEntry =
  | Readonly<{
      kind: 'tool';
      key: string;
      tool: ToolState;
    }>
  | Readonly<{
      kind: 'message';
      key: string;
      message: TimelineMessage;
    }>;

export function buildTimelineEntries(sdkEvents: readonly SdkEvent[], tools: readonly ToolState[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const seenToolUseIds = new Set<string>();
  const toolById = new Map<string, ToolState>();
  for (const tool of tools) {
    toolById.set(tool.tool_use_id, tool);
  }

  for (let i = 0; i < sdkEvents.length; i += 1) {
    const event = sdkEvents[i];
    if (event.event === 'sdk-message') {
      const message = toMessage(event.data);
      if (!message) continue;
      out.push({
        kind: 'message',
        key: `msg-${i}`,
        message,
      });
      continue;
    }

    if (event.event !== 'sdk-tool-start' && event.event !== 'sdk-tool-complete') continue;
    if (!isRecord(event.data)) continue;
    const toolUseId = typeof event.data.tool_use_id === 'string' ? event.data.tool_use_id : '';
    if (!toolUseId || seenToolUseIds.has(toolUseId)) continue;

    const tool = toolById.get(toolUseId);
    if (!tool) continue;
    seenToolUseIds.add(toolUseId);
    out.push({
      kind: 'tool',
      key: `tool-${toolUseId}`,
      tool,
    });
  }

  return out;
}

export function entryMatchesFilter(entry: TimelineEntry, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;

  if (entry.kind === 'tool') {
    const t = entry.tool;
    return (
      t.name.toLowerCase().includes(q) ||
      JSON.stringify(t.input).toLowerCase().includes(q) ||
      (t.response_text ?? '').toLowerCase().includes(q)
    );
  }

  return entry.message.type.includes(q) || entry.message.content.toLowerCase().includes(q);
}
