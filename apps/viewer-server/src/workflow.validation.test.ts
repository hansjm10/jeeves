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

    // Find the transition to implement_task
    const passTransition = preCheck.transitions.find((t) => t.to === 'implement_task');

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

  it('design_review transitions to pre_implementation_check (not directly to implement_task)', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    const designReview = workflow.phases.design_review;

    // Verify there is a transition to pre_implementation_check
    const toPreCheck = designReview.transitions.find((t) => t.to === 'pre_implementation_check');
    expect(toPreCheck).toBeDefined();
    expect(toPreCheck?.when).toBe('status.designApproved == true');

    // Verify there is NO direct transition to implement_task
    const toImplement = designReview.transitions.find((t) => t.to === 'implement_task');
    expect(toImplement).toBeUndefined();
  });

  it('workflow forms valid pre-check transition graph', async () => {
    const workflowPath = fileURLToPath(new URL('../../../workflows/default.yaml', import.meta.url));
    const workflow = await loadWorkflowFromFile(workflowPath);

    // Verify the complete transition graph for the pre-check flow:
    // design_review -> pre_implementation_check -> implement_task (on pass)
    // design_review -> pre_implementation_check -> design_edit (on fail)

    const designReview = workflow.phases.design_review;
    const preCheck = workflow.phases.pre_implementation_check;

    // design_review transitions to pre_implementation_check when designApproved
    const reviewToPreCheck = designReview.transitions.find(
      (t) => t.to === 'pre_implementation_check' && t.when === 'status.designApproved == true',
    );
    expect(reviewToPreCheck).toBeDefined();

    // pre_implementation_check has exactly two transitions (pass and fail)
    expect(preCheck.transitions).toHaveLength(2);

    // Verify pass transition
    const passTransition = preCheck.transitions.find((t) => t.to === 'implement_task');
    expect(passTransition).toBeDefined();
    expect(passTransition?.when).toBe('status.preCheckPassed == true');

    // Verify fail transition
    const failTransition = preCheck.transitions.find((t) => t.to === 'design_edit');
    expect(failTransition).toBeDefined();
    expect(failTransition?.when).toBe('status.preCheckFailed == true');
  });
});
