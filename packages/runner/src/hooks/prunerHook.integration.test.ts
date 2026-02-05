import { describe, expect, it } from 'vitest';

import { PrunerHook } from './prunerHook.js';

const enabled = process.env.JEEVES_PRUNER_INTEGRATION === '1';
const prunerUrl = process.env.JEEVES_PRUNER_URL ?? 'http://localhost:8000/prune';

const integrationIt = enabled ? it : it.skip;

describe('PrunerHook (integration)', () => {
  integrationIt('prunes tool_result content via external service', async () => {
    const hook = new PrunerHook({
      prunerUrl,
      enabled: true,
      targetTools: ['Read'],
      query: 'Keep only the IMPORTANT line.',
      timeoutMs: 30_000,
    });

    const original = [
      'line 1: filler',
      'line 2: filler',
      'IMPORTANT: keep me',
      'line 4: filler',
      'line 5: filler',
    ].join('\n');

    const out = await hook.onToolResult(
      { type: 'tool_result', toolUseId: 't1', content: original },
      { toolUseId: 't1', toolName: 'Read', input: { path: 'README.md' } },
    );

    expect(out.content).toContain('IMPORTANT');
    expect(out.content.length).toBeLessThanOrEqual(original.length);
  });
});
