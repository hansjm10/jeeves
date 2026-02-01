import type { AgentProvider, ProviderEvent, ProviderRunOptions } from '../provider.js';

function nowIso(): string {
  return new Date().toISOString();
}

export class FakeProvider implements AgentProvider {
  readonly name = 'fake';

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    void options;
    const model = process.env.JEEVES_MODEL;
    const modelInfo = model ? ` (model=${model})` : '';
    yield {
      type: 'system',
      subtype: 'init',
      content: `Fake provider init${modelInfo}`,
      sessionId: 'fake-session',
      timestamp: nowIso(),
    };
    yield { type: 'user', content: prompt.slice(0, 2000), timestamp: nowIso() };
    yield { type: 'assistant', content: 'Hello from FakeProvider.', timestamp: nowIso() };
    yield { type: 'result', content: '<promise>COMPLETE</promise>', timestamp: nowIso() };
  }
}
