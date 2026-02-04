import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { Workflow } from './workflow.js';
import { resolvePromptPath } from './promptResolution.js';
import { WorkflowEngine } from './workflowEngine.js';

describe('resolvePromptPath', () => {
  it('resolves prompt paths within promptsDir', async () => {
    const promptsDir = fileURLToPath(new URL('../../../prompts', import.meta.url));

    const workflow: Workflow = {
      name: 't',
      version: 1,
      start: 'design_classify',
      phases: {
        design_classify: {
          name: 'design_classify',
          type: 'execute',
          prompt: 'design.classify.md',
          transitions: [],
          allowedWrites: ['.jeeves/*'],
        },
        complete: { name: 'complete', type: 'terminal', transitions: [], allowedWrites: ['.jeeves/*'] },
      },
    };

    const engine = new WorkflowEngine(workflow);
    const resolved = await resolvePromptPath('design_classify', promptsDir, engine);
    expect(resolved.endsWith('/prompts/design.classify.md') || resolved.endsWith('\\prompts\\design.classify.md')).toBe(true);
  });

  it('includes verdict rules in the design review prompt', async () => {
    const promptPath = fileURLToPath(new URL('../../../prompts/design.review.md', import.meta.url));
    const content = await readFile(promptPath, 'utf8');
    expect(content).toContain('## Verdict Rules');
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
