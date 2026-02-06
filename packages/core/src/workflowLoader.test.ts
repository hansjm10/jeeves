import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadWorkflowFromFile, parseWorkflowObject, parseWorkflowYaml, toRawWorkflowJson, toWorkflowYaml } from './workflowLoader.js';

describe('workflowLoader', () => {
  it('loads and validates the repo default workflow YAML', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    expect(workflow.name).toBe('default');
    expect(workflow.start).toBe('design_classify');
    expect(workflow.phases.design_classify.type).toBe('execute');
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

  it('toRawWorkflowJson includes default_provider and phase.provider when set', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'provider-json-test',
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

    const rawJson = toRawWorkflowJson(workflow);
    const workflowSection = rawJson.workflow as Record<string, unknown>;
    const phasesSection = rawJson.phases as Record<string, Record<string, unknown>>;

    expect(workflowSection.default_provider).toBe('openai');
    expect(phasesSection.start.provider).toBe('anthropic');
    expect(phasesSection.complete.provider).toBeUndefined();
  });

  it('toRawWorkflowJson omits provider fields when not set', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'no-provider-test',
        version: 1,
        start: 'start',
      },
      phases: {
        start: {
          type: 'execute',
          prompt: 'Do the thing.',
          transitions: [{ to: 'complete' }],
        },
        complete: { type: 'terminal' },
      },
    });

    const rawJson = toRawWorkflowJson(workflow);
    const workflowSection = rawJson.workflow as Record<string, unknown>;
    const phasesSection = rawJson.phases as Record<string, Record<string, unknown>>;

    expect('default_provider' in workflowSection).toBe(false);
    expect('provider' in phasesSection.start).toBe(false);
  });

  it('round-trips workflow.default_reasoning_effort (Codex)', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'reasoning-default',
        version: 1,
        start: 'start',
        default_provider: 'codex',
        default_model: 'gpt-5.2',
        default_reasoning_effort: 'xhigh',
      },
      phases: {
        start: { type: 'execute', prompt: 'Start', transitions: [{ to: 'complete' }] },
        complete: { type: 'terminal' },
      },
    });

    const raw = toRawWorkflowJson(workflow);
    expect((raw.workflow as Record<string, unknown>).default_reasoning_effort).toBe('xhigh');

    const yaml = toWorkflowYaml(workflow);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed).toEqual(workflow);
  });

  it('round-trips workflow.default_thinking_budget (Claude)', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'thinking-default',
        version: 1,
        start: 'start',
        default_provider: 'claude',
        default_model: 'sonnet',
        default_thinking_budget: 'high',
      },
      phases: {
        start: { type: 'execute', prompt: 'Start', transitions: [{ to: 'complete' }] },
        complete: { type: 'terminal' },
      },
    });

    const raw = toRawWorkflowJson(workflow);
    expect((raw.workflow as Record<string, unknown>).default_thinking_budget).toBe('high');

    const yaml = toWorkflowYaml(workflow);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed).toEqual(workflow);
  });

  it('round-trips per-phase reasoning_effort and thinking_budget', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'per-phase-budgets',
        version: 1,
        start: 'codex_phase',
      },
      phases: {
        codex_phase: {
          type: 'execute',
          provider: 'codex',
          model: 'gpt-5.2',
          reasoning_effort: 'xhigh',
          prompt: 'Codex',
          transitions: [{ to: 'claude_phase' }],
        },
        claude_phase: {
          type: 'execute',
          provider: 'claude',
          model: 'sonnet',
          thinking_budget: 'medium',
          prompt: 'Claude',
          transitions: [{ to: 'complete' }],
        },
        complete: { type: 'terminal' },
      },
    });

    const raw = toRawWorkflowJson(workflow);
    const phases = raw.phases as Record<string, Record<string, unknown>>;
    expect(phases.codex_phase.reasoning_effort).toBe('xhigh');
    expect(phases.claude_phase.thinking_budget).toBe('medium');

    const yaml = toWorkflowYaml(workflow);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed).toEqual(workflow);
  });

  it('rejects invalid reasoning_effort values', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'codex',
            model: 'gpt-5.2',
            reasoning_effort: 'banana',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/invalid reasoning_effort/i);
  });

  it('rejects invalid thinking_budget values', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'claude',
            model: 'sonnet',
            thinking_budget: 'banana',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/invalid thinking_budget/i);
  });

  it('rejects provider/model mismatches for reasoning_effort', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'claude',
            model: 'sonnet',
            reasoning_effort: 'high',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/requires effective provider 'codex'/i);
  });

  it('rejects provider/model mismatches for thinking_budget', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'codex',
            model: 'gpt-5.2',
            thinking_budget: 'medium',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/requires effective provider 'claude'/i);
  });

  it('rejects reasoning_effort for models that do not support it', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'codex',
            model: 'gpt-5-codex',
            reasoning_effort: 'high',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/supports reasoning effort/i);
  });

  it('rejects reasoning_effort xhigh for gpt-5.1-codex-max', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'codex',
            model: 'gpt-5.1-codex-max',
            reasoning_effort: 'xhigh',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/not supported for model 'gpt-5.1-codex-max'/i);
  });

  it('rejects reasoning_effort when an effective model is not set', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'codex',
            reasoning_effort: 'high',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/requires an effective model/i);
  });

  it('rejects workflow default_reasoning_effort when default_model is not set', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: {
          name: 'bad',
          version: 1,
          start: 'start',
          default_provider: 'codex',
          default_reasoning_effort: 'high',
        },
        phases: {
          start: { type: 'execute', prompt: 'Start', transitions: [{ to: 'complete' }] },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/default_model/i);
  });

  it('rejects workflow default_thinking_budget when default_model is not set', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: {
          name: 'bad',
          version: 1,
          start: 'start',
          default_provider: 'claude',
          default_thinking_budget: 'medium',
        },
        phases: {
          start: { type: 'execute', prompt: 'Start', transitions: [{ to: 'complete' }] },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/default_model/i);
  });

  it('round-trips per-phase permission_mode', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'permission-mode-test',
        version: 1,
        start: 'plan',
      },
      phases: {
        plan: {
          type: 'execute',
          provider: 'claude',
          model: 'opus',
          permission_mode: 'plan',
          prompt: 'Plan',
          transitions: [{ to: 'complete' }],
        },
        complete: { type: 'terminal' },
      },
    });

    expect(workflow.phases.plan.permissionMode).toBe('plan');

    const raw = toRawWorkflowJson(workflow);
    const phases = raw.phases as Record<string, Record<string, unknown>>;
    expect(phases.plan.permission_mode).toBe('plan');

    const yaml = toWorkflowYaml(workflow);
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed).toEqual(workflow);
  });

  it('omits permission_mode when not set', () => {
    const workflow = parseWorkflowObject({
      workflow: {
        name: 'no-perm-mode',
        version: 1,
        start: 'start',
      },
      phases: {
        start: {
          type: 'execute',
          prompt: 'Start',
          transitions: [{ to: 'complete' }],
        },
        complete: { type: 'terminal' },
      },
    });

    expect(workflow.phases.start.permissionMode).toBeUndefined();

    const raw = toRawWorkflowJson(workflow);
    const phases = raw.phases as Record<string, Record<string, unknown>>;
    expect('permission_mode' in phases.start).toBe(false);
  });

  it('rejects permission_mode plan with non-claude provider', () => {
    expect(() =>
      parseWorkflowObject({
        workflow: { name: 'bad', version: 1, start: 'start' },
        phases: {
          start: {
            type: 'execute',
            provider: 'codex',
            model: 'gpt-5.2',
            permission_mode: 'plan',
            prompt: 'Start',
            transitions: [{ to: 'complete' }],
          },
          complete: { type: 'terminal' },
        },
      }),
    ).toThrow(/permission_mode 'plan' requires effective provider 'claude'/i);
  });
});
