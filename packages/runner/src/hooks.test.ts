import { describe, expect, it } from 'vitest';

import { EventHookPipeline, type EventHook } from './hooks.js';
import type { ProviderEvent } from './provider.js';

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('EventHookPipeline', () => {
  it('invokes hooks and can transform tool_result', async () => {
    const calls: string[] = [];
    const hook: EventHook = {
      name: 't1',
      async onToolUse(_evt, ctx) {
        calls.push(`use:${ctx.toolName}:${ctx.toolUseId}`);
      },
      async onToolResult(evt, ctx) {
        calls.push(`result:${ctx.toolName}:${ctx.toolUseId}`);
        return { ...evt, content: `PRUNED:${evt.content}` };
      },
    };

    async function* gen(): AsyncIterable<ProviderEvent> {
      yield { type: 'system', content: 'hi' };
      yield { type: 'tool_use', name: 'Read', input: { path: 'x' }, id: 'u1' };
      yield { type: 'tool_result', toolUseId: 'u1', content: 'ORIG' };
      yield { type: 'assistant', content: 'done' };
    }

    const pipeline = new EventHookPipeline();
    pipeline.addHook(hook);

    const out = await collect(pipeline.process(gen()));
    expect(calls).toEqual(['use:Read:u1', 'result:Read:u1']);
    expect(out).toMatchObject([
      { type: 'system', content: 'hi' },
      { type: 'tool_use', name: 'Read', id: 'u1' },
      { type: 'tool_result', toolUseId: 'u1', content: 'PRUNED:ORIG' },
      { type: 'assistant', content: 'done' },
    ]);
  });

  it('does not break the stream if a hook throws', async () => {
    const hook: EventHook = {
      name: 'boom',
      async onToolResult() {
        throw new Error('kaboom');
      },
    };

    async function* gen(): AsyncIterable<ProviderEvent> {
      yield { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' }, id: 't1' };
      yield { type: 'tool_result', toolUseId: 't1', content: 'ok' };
    }

    const pipeline = new EventHookPipeline();
    pipeline.addHook(hook);

    const out = await collect(pipeline.process(gen()));
    expect(out[0]).toMatchObject({ type: 'tool_use', id: 't1' });
    expect(out[1]).toMatchObject({ type: 'system', subtype: 'error' });
    expect(out[2]).toMatchObject({ type: 'tool_result', toolUseId: 't1', content: 'ok' });
  });
});

