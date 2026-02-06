import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentProvider, ProviderEvent, ProviderRunOptions } from './provider.js';
import { extractTaskPlanFromSdkOutput, runSinglePhaseOnce } from './runner.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAssistantEnvelope(blocks: unknown[], id = 'msg_1'): string {
  return JSON.stringify({
    model: 'claude-opus-4-6',
    id,
    type: 'message',
    role: 'assistant',
    content: blocks,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    context_management: null,
  });
}

class TranscriptLikePlanProvider implements AgentProvider {
  readonly name = 'transcript-like-test-provider';

  async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    void prompt;
    void options;
    yield {
      type: 'assistant',
      content: "I'll start by reading issue metadata.",
    };
    yield {
      type: 'assistant',
      content: makeAssistantEnvelope(
        [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '.jeeves/issue.json' } }],
        'msg_2',
      ),
    };
    yield {
      type: 'assistant',
      content: makeAssistantEnvelope(
        [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'Write',
            input: {
              file_path: '.jeeves/task-plan.md',
              content: '# Clean Plan\n\n1. Verify state\n2. Apply change\n3. Validate',
            },
          },
        ],
        'msg_3',
      ),
    };
    yield { type: 'result', content: 'done' };
  }
}

describe('task-plan extraction', () => {
  it('prefers task-plan content from assistant Write tool envelopes', () => {
    const output = {
      schema: 'jeeves.sdk.v1',
      messages: [
        { type: 'assistant', content: "I'll inspect the workspace first." },
        {
          type: 'assistant',
          content: makeAssistantEnvelope(
            [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '.jeeves/issue.json' } }],
            'msg_a',
          ),
        },
        {
          type: 'assistant',
          content: makeAssistantEnvelope(
            [
              {
                type: 'tool_use',
                id: 'toolu_b',
                name: 'Write',
                input: {
                  file_path: '.jeeves/task-plan.md',
                  content: '# Canonical Plan\n\n- Step A\n- Step B',
                },
              },
            ],
            'msg_b',
          ),
        },
      ],
    };

    const plan = extractTaskPlanFromSdkOutput(JSON.stringify(output));
    expect(plan).toBe('# Canonical Plan\n\n- Step A\n- Step B');
  });

  it('extracts text blocks from assistant envelopes and ignores tool-only wrappers', () => {
    const output = {
      schema: 'jeeves.sdk.v1',
      messages: [
        {
          type: 'assistant',
          content: makeAssistantEnvelope([{ type: 'text', text: 'Plan from envelope' }], 'msg_text'),
        },
        {
          type: 'assistant',
          content: makeAssistantEnvelope(
            [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: '.jeeves/tasks.json' } }],
            'msg_tool',
          ),
        },
        { type: 'assistant', content: 'Plain assistant note' },
      ],
    };

    const plan = extractTaskPlanFromSdkOutput(JSON.stringify(output));
    expect(plan).toBe('Plan from envelope\n\nPlain assistant note');
  });

  it('writes a clean task-plan.md in a temporary plan-phase run', async () => {
    const tmp = await makeTempDir('jeeves-plan-extract-');
    const workflowsDir = path.join(tmp, 'workflows');
    const promptsDir = path.join(tmp, 'prompts');
    const stateDir = path.join(tmp, 'state');
    const cwd = path.join(tmp, 'work');

    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    await fs.writeFile(
      path.join(workflowsDir, 'plan-fixture.yaml'),
      [
        'workflow:',
        '  name: plan-fixture',
        '  version: 1',
        '  start: plan_phase',
        'phases:',
        '  plan_phase:',
        '    type: execute',
        '    prompt: plan.prompt.md',
        '    permission_mode: plan',
        '    transitions: []',
      ].join('\n') + '\n',
      'utf-8',
    );

    await fs.writeFile(path.join(promptsDir, 'plan.prompt.md'), '# plan prompt\n', 'utf-8');

    const result = await runSinglePhaseOnce({
      provider: new TranscriptLikePlanProvider(),
      workflowName: 'plan-fixture',
      phaseName: 'plan_phase',
      workflowsDir,
      promptsDir,
      stateDir,
      cwd,
    });

    expect(result).toEqual({ phase: 'plan_phase', success: true });

    const taskPlan = await fs.readFile(path.join(stateDir, 'task-plan.md'), 'utf-8');
    expect(taskPlan).toBe('# Clean Plan\n\n1. Verify state\n2. Apply change\n3. Validate');
    expect(taskPlan).not.toContain('"tool_use"');
    expect(taskPlan).not.toContain('"model":"claude-opus-4-6"');
  });
});
