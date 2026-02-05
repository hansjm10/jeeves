import type { ProviderEvent } from '../provider.js';
import type { EventHook, ToolContext } from '../hooks.js';

export interface PrunerHookOptions {
  prunerUrl: string;
  enabled: boolean;
  targetTools: string[];
  query: string;
  timeoutMs?: number;
  threshold?: number;
}

function normalizeList(list: string[]): Set<string> {
  return new Set(list.map((t) => t.trim()).filter(Boolean));
}

function firstStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') return v;
  }
  return null;
}

async function readPrunedContent(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = (await res.json().catch(() => null)) as unknown;
    if (json && typeof json === 'object') {
      const obj = json as Record<string, unknown>;
      const v = firstStringField(obj, ['pruned_code', 'pruned', 'content', 'result', 'text', 'code']);
      if (v !== null) return v;
    }
  }
  return await res.text();
}

export class PrunerHook implements EventHook {
  readonly name = 'pruner';
  private readonly opts: PrunerHookOptions;
  private readonly targetTools: Set<string>;

  constructor(options: PrunerHookOptions) {
    this.opts = options;
    this.targetTools = normalizeList(options.targetTools);
  }

  async onToolResult(
    event: ProviderEvent & { type: 'tool_result' },
    ctx: ToolContext,
  ): Promise<ProviderEvent & { type: 'tool_result' }> {
    if (!this.opts.enabled) return event;
    if (!this.targetTools.has(ctx.toolName)) return event;
    if (!event.content) return event;

    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.opts.prunerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: event.content,
          query: this.opts.query,
          ...(this.opts.threshold !== undefined ? { threshold: this.opts.threshold } : {}),
          tool: ctx.toolName,
          tool_input: ctx.input,
          tool_use_id: ctx.toolUseId,
        }),
        signal: controller.signal,
      });

      if (!res.ok) return event;

      const pruned = await readPrunedContent(res);
      const trimmed = pruned.trim();
      if (!trimmed) return event;

      return { ...event, content: pruned };
    } catch {
      return event;
    } finally {
      clearTimeout(timeout);
    }
  }
}
