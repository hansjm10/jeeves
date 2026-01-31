import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadWorkflowFromFile, parseWorkflowObject, parseWorkflowYaml, toWorkflowYaml } from './workflowLoader.js';

describe('workflowLoader', () => {
  it('loads and validates the repo default workflow YAML', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    expect(workflow.name).toBe('default');
    expect(workflow.start).toBe('design_draft');
    expect(workflow.phases.design_draft.type).toBe('execute');
    expect(workflow.phases.design_review.type).toBe('evaluate');
    expect(workflow.phases.complete.type).toBe('terminal');
    expect(workflow.phases.task_spec_check.transitions.length).toBeGreaterThan(1);
  });

  it('parses provider fields from a raw workflow object', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'provider-test',
        version: 1,
        start: 'start',
        default_provider: 'openai',
      },
      phases: {
        start: {
          type: 'execute',
          provider: 'anthropic',
          prompt: 'Do the thing.',
          transitions: [{ to: 'complete' }],
        },
        complete: { type: 'terminal' },
      },
    });

    expect(workflow.defaultProvider).toBe('openai');
    expect(workflow.phases.start.provider).toBe('anthropic');
  });

  it('serializes deterministically and supports parse→serialize→parse round-trip', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'round-trip',
        version: 1,
        start: 'alpha',
        default_provider: 'openai',
      },
      phases: {
        zeta: { type: 'execute', prompt: 'Zeta', transitions: [] },
        alpha: { type: 'execute', prompt: 'Alpha', transitions: [{ to: 'complete' }] },
        complete: { type: 'terminal' },
      },
    });

    const yaml1 = toWorkflowYaml(workflow);
    const yaml2 = toWorkflowYaml(workflow);
    expect(yaml1).toBe(yaml2);
    expect(yaml1.startsWith('workflow:')).toBe(true);
    expect(yaml1.indexOf('\nphases:')).toBeGreaterThan(0);
    expect(yaml1.indexOf('workflow:')).toBeLessThan(yaml1.indexOf('phases:'));
    expect(yaml1.indexOf('  alpha:')).toBeLessThan(yaml1.indexOf('  zeta:'));

    const parsedAgain = parseWorkflowYaml(yaml1);
    expect(parsedAgain).toEqual(workflow);
  });
});
