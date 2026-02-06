import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadWorkflowFromFile } from '@jeeves/core';

/**
 * Tests to validate the default workflow structure, specifically:
 * - The presence and configuration of the pre_implementation_check phase
 * - Correct pass/fail transitions for pre_implementation_check
 *
 * These tests ensure the workflow graph is valid and correctly routes
 * between design approval, pre-implementation verification, and implementation.
 */
describe('default workflow validation', () => {
  it('includes pre_implementation_check phase with correct prompt reference', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    // Verify pre_implementation_check phase exists
    expect(workflow.phases).toHaveProperty('pre_implementation_check');

    const preCheck = workflow.phases.pre_implementation_check;

    // Verify the phase references the correct prompt
    expect(preCheck.prompt).toBe('verify.pre_implementation.md');

    // Verify the phase is an evaluate type (read-only verification)
    expect(preCheck.type).toBe('evaluate');
  });

  it('pre_implementation_check transitions to implement_task when preCheckPassed is true', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    const preCheck = workflow.phases.pre_implementation_check;

    // Find the transition to plan_task (planning phase before implement)
    const passTransition = preCheck.transitions.find((t) => t.to === 'plan_task');

    expect(passTransition).toBeDefined();
    expect(passTransition?.when).toBe('status.preCheckPassed == true');
  });

  it('pre_implementation_check transitions to design_edit when preCheckFailed is true', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    const preCheck = workflow.phases.pre_implementation_check;

    // Find the transition to design_edit
    const failTransition = preCheck.transitions.find((t) => t.to === 'design_edit');

    expect(failTransition).toBeDefined();
    expect(failTransition?.when).toBe('status.preCheckFailed == true');
  });

  it('design_review transitions to task_decomposition (not directly to implement_task)', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    const designReview = workflow.phases.design_review;

    // Verify there is a transition to task_decomposition
    const toTaskDecomp = designReview.transitions.find((t) => t.to === 'task_decomposition');
    expect(toTaskDecomp).toBeDefined();
    expect(toTaskDecomp?.when).toBe('status.designApproved == true');

    // Verify there is NO direct transition to implement_task
    const toImplement = designReview.transitions.find((t) => t.to === 'implement_task');
    expect(toImplement).toBeUndefined();
  });

  it('task_decomposition phase exists and transitions to pre_implementation_check', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    // Verify task_decomposition phase exists
    expect(workflow.phases).toHaveProperty('task_decomposition');

    const taskDecomp = workflow.phases.task_decomposition;
    expect(taskDecomp.type).toBe('execute');
    expect(taskDecomp.prompt).toBe('task.decompose.md');

    // Verify it auto-transitions to pre_implementation_check
    const toPreCheck = taskDecomp.transitions.find((t) => t.to === 'pre_implementation_check');
    expect(toPreCheck).toBeDefined();
  });

  it('workflow forms valid pre-check transition graph', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    // Verify the complete transition graph for the pre-check flow:
    // design_review -> task_decomposition -> pre_implementation_check -> implement_task (on pass)
    // design_review -> task_decomposition -> pre_implementation_check -> design_edit (on fail)

    const designReview = workflow.phases.design_review;
    const taskDecomp = workflow.phases.task_decomposition;
    const preCheck = workflow.phases.pre_implementation_check;

    // design_review transitions to task_decomposition when designApproved
    const reviewToTaskDecomp = designReview.transitions.find(
      (t) => t.to === 'task_decomposition' && t.when === 'status.designApproved == true',
    );
    expect(reviewToTaskDecomp).toBeDefined();

    // task_decomposition auto-transitions to pre_implementation_check
    const taskDecompToPreCheck = taskDecomp.transitions.find((t) => t.to === 'pre_implementation_check');
    expect(taskDecompToPreCheck).toBeDefined();

    // pre_implementation_check has exactly two transitions (pass and fail)
    expect(preCheck.transitions).toHaveLength(2);

    // Verify pass transition (now routes to plan_task before implement)
    const passTransition = preCheck.transitions.find((t) => t.to === 'plan_task');
    expect(passTransition).toBeDefined();
    expect(passTransition?.when).toBe('status.preCheckPassed == true');

    // Verify fail transition
    const failTransition = preCheck.transitions.find((t) => t.to === 'design_edit');
    expect(failTransition).toBeDefined();
    expect(failTransition?.when).toBe('status.preCheckFailed == true');
  });
});
