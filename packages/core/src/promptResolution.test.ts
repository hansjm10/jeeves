import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Workflow } from './workflow';
import { resolvePromptPath } from './promptResolution';
import { WorkflowEngine } from './workflowEngine';

describe('resolvePromptPath', () => {
  it('resolves prompt paths within promptsDir', async () => {
    const promptsDir = fileURLToPath(new URL('../../../prompts', import.meta.url));

    const workflow: Workflow = {
      name: 't',
      version: 1,
      start: 'design_draft',
      phases: {
        design_draft: {
          name: 'design_draft',
          type: 'execute',
          prompt: 'design.draft.md',
          transitions: [],
          allowedWrites: ['.jeeves/*'],
        },
        complete: { name: 'complete', type: 'terminal', transitions: [], allowedWrites: ['.jeeves/*'] },
      },
    };

    const engine = new WorkflowEngine(workflow);
    const resolved = await resolvePromptPath('design_draft', promptsDir, engine);
    expect(resolved.endsWith('/prompts/design.draft.md') || resolved.endsWith('\\prompts\\design.draft.md')).toBe(true);
  });

  it('blocks path traversal and errors on missing prompts', async () => {
    const promptsDir = fileURLToPath(new URL('../../../prompts', import.meta.url));

    const traversal: Workflow = {
      name: 't',
      version: 1,
      start: 'p',
      phases: {
        p: { name: 'p', type: 'execute', prompt: '../x', transitions: [], allowedWrites: ['.jeeves/*'] },
      },
    };
    await expect(resolvePromptPath('p', promptsDir, new WorkflowEngine(traversal))).rejects.toThrow(/Invalid prompt path/);

    const missing: Workflow = {
      name: 't',
      version: 1,
      start: 'p',
      phases: {
        p: { name: 'p', type: 'execute', prompt: 'does-not-exist.md', transitions: [], allowedWrites: ['.jeeves/*'] },
      },
    };
    await expect(resolvePromptPath('p', promptsDir, new WorkflowEngine(missing))).rejects.toThrow(/Prompt not found/);
  });
});

