import type { ProviderEvent } from './provider.js';

export interface ToolContext {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface EventHook {
  readonly name: string;

  /** Called when a tool_use event is emitted */
  onToolUse?(
    event: ProviderEvent & { type: 'tool_use' },
    ctx: ToolContext,
  ): Promise<void>;

  /** Called when a tool_result event is emitted - can transform content */
  onToolResult?(
    event: ProviderEvent & { type: 'tool_result' },
    ctx: ToolContext,
  ): Promise<ProviderEvent & { type: 'tool_result' }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hookErrorToSystemEvent(hookName: string, err: unknown): ProviderEvent & { type: 'system' } {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  return {
    type: 'system',
    subtype: 'error',
    content: `[hook:${hookName}] ${message}`,
    timestamp: nowIso(),
  };
}

export class EventHookPipeline {
  private readonly hooks: EventHook[] = [];
  private readonly toolContextById = new Map<string, ToolContext>();

  addHook(hook: EventHook): void {
    this.hooks.push(hook);
  }

  async *process(events: AsyncIterable<ProviderEvent>): AsyncIterable<ProviderEvent> {
    for await (const evt of events) {
      if (evt.type === 'tool_use') {
        const ctx: ToolContext = {
          toolUseId: evt.id,
          toolName: evt.name,
          input: evt.input,
        };
        this.toolContextById.set(evt.id, ctx);

        for (const hook of this.hooks) {
          if (!hook.onToolUse) continue;
          try {
            await hook.onToolUse(evt, ctx);
          } catch (err) {
            yield hookErrorToSystemEvent(hook.name, err);
          }
        }

        yield evt;
        continue;
      }

      if (evt.type === 'tool_result') {
        const ctx: ToolContext =
          this.toolContextById.get(evt.toolUseId)
          ?? {
            toolUseId: evt.toolUseId,
            toolName: 'unknown',
            input: {},
          };

        let out: ProviderEvent & { type: 'tool_result' } = evt;
        for (const hook of this.hooks) {
          if (!hook.onToolResult) continue;
          try {
            out = await hook.onToolResult(out, ctx);
          } catch (err) {
            yield hookErrorToSystemEvent(hook.name, err);
          }
        }

        yield out;
        // Best-effort cleanup. (Providers currently emit at most one tool_result per tool_use.)
        this.toolContextById.delete(evt.toolUseId);
        continue;
      }

      yield evt;
    }
  }
}

