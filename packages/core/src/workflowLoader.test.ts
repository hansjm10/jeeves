import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadWorkflowFromFile } from './workflowLoader.js';

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
});
