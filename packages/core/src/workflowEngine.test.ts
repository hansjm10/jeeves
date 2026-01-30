import { describe, expect, it } from 'vitest';

import type { Workflow } from './workflow.js';
import { WorkflowEngine } from './workflowEngine.js';

describe('WorkflowEngine', () => {
  it('selects the first matching transition in order', () => {
    const workflow: Workflow = {
      name: 't',
      version: 1,
      start: 'a',
      phases: {
        a: {
          name: 'a',
          type: 'execute',
          prompt: 'x',
          transitions: [
            { to: 'b', when: 'status.ready == true', auto: false, priority: 0 },
            { to: 'c', auto: true, priority: 1 },
          ],
          allowedWrites: ['.jeeves/*'],
        },
        b: { name: 'b', type: 'terminal', transitions: [], allowedWrites: ['.jeeves/*'] },
        c: { name: 'c', type: 'terminal', transitions: [], allowedWrites: ['.jeeves/*'] },
      },
    };

    const engine = new WorkflowEngine(workflow);
    expect(engine.evaluateTransitions('a', { status: { ready: true } })).toBe('b');
    expect(engine.evaluateTransitions('a', { status: { ready: false } })).toBe('c');
  });

  it('returns null for unknown or terminal phases', () => {
    const workflow: Workflow = {
      name: 't',
      version: 1,
      start: 'done',
      phases: {
        done: { name: 'done', type: 'terminal', transitions: [], allowedWrites: ['.jeeves/*'] },
      },
    };
    const engine = new WorkflowEngine(workflow);
    expect(engine.evaluateTransitions('missing', {})).toBe(null);
    expect(engine.evaluateTransitions('done', {})).toBe(null);
  });
});
