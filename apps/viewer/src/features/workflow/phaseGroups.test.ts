import { describe, expect, it } from 'vitest';

import type { WorkflowResponse } from '../../api/types.js';
import { groupForPhase, pickGroupTarget } from './phaseGroups.js';

describe('groupForPhase', () => {
  it('defaults to design for null', () => {
    expect(groupForPhase(null)).toBe('design');
  });

  it('groups design_* into design', () => {
    expect(groupForPhase('design_draft')).toBe('design');
  });

  it('groups design_research into design', () => {
    expect(groupForPhase('design_research')).toBe('design');
  });

  it('groups prepare_pr into review', () => {
    expect(groupForPhase('prepare_pr')).toBe('review');
  });

  it('groups complete into complete', () => {
    expect(groupForPhase('complete')).toBe('complete');
  });
});

describe('pickGroupTarget', () => {
  const defaultLikeWorkflow: WorkflowResponse = {
    ok: true,
    workflow_name: 'default',
    start_phase: 'design_classify',
    current_phase: 'implement_task',
    phases: [
      { id: 'code_fix', name: 'Code Fix', type: 'execute', description: '' },
      { id: 'code_review', name: 'Code Review', type: 'evaluate', description: '' },
      { id: 'complete', name: 'Complete', type: 'terminal', description: '' },
      { id: 'completeness_verification', name: 'Completeness Verification', type: 'evaluate', description: '' },
      { id: 'design_classify', name: 'Design Classify', type: 'execute', description: '' },
      { id: 'design_research', name: 'Design Research', type: 'execute', description: '' },
      { id: 'task_decomposition', name: 'Task Decomposition', type: 'execute', description: '' },
      { id: 'implement_task', name: 'Implement Task', type: 'execute', description: '' },
      { id: 'pre_implementation_check', name: 'Pre-Implementation Check', type: 'evaluate', description: '' },
      { id: 'prepare_pr', name: 'Prepare PR', type: 'execute', description: '' },
    ],
    phase_order: [
      'code_fix',
      'code_review',
      'complete',
      'completeness_verification',
      'design_classify',
      'design_research',
      'task_decomposition',
      'implement_task',
      'pre_implementation_check',
      'prepare_pr',
    ],
  };

  it('picks design anchor for design group', () => {
    expect(pickGroupTarget(defaultLikeWorkflow, 'design')).toBe('design_classify');
  });

  it('picks design_research when design_classify is absent', () => {
    const workflowWithoutClassify: WorkflowResponse = {
      ...defaultLikeWorkflow,
      phases: defaultLikeWorkflow.phases.filter((p) => p.id !== 'design_classify'),
      phase_order: defaultLikeWorkflow.phase_order.filter((p) => p !== 'design_classify'),
    };
    expect(pickGroupTarget(workflowWithoutClassify, 'design')).toBe('design_research');
  });

  it('picks implement_task for implement group regardless of phase order', () => {
    expect(pickGroupTarget(defaultLikeWorkflow, 'implement')).toBe('implement_task');
  });

  it('picks review anchor for review group', () => {
    expect(pickGroupTarget(defaultLikeWorkflow, 'review')).toBe('prepare_pr');
  });

  it('picks complete anchor for complete group', () => {
    expect(pickGroupTarget(defaultLikeWorkflow, 'complete')).toBe('complete');
  });

  const customWorkflow: WorkflowResponse = {
    ok: true,
    workflow_name: 'custom',
    start_phase: 'alpha',
    current_phase: 'alpha',
    phases: [
      { id: 'alpha', name: 'Alpha', type: 'execute', description: '' },
      { id: 'beta_review', name: 'Beta Review', type: 'evaluate', description: '' },
      { id: 'omega', name: 'Omega', type: 'terminal', description: '' },
    ],
    phase_order: ['alpha', 'beta_review', 'omega'],
  };

  it('falls back to start phase for design group when no design_* exists', () => {
    expect(pickGroupTarget(customWorkflow, 'design')).toBe('alpha');
  });

  it('falls back to heuristic for implement group on custom workflows', () => {
    expect(pickGroupTarget(customWorkflow, 'implement')).toBe('alpha');
  });

  it('falls back to heuristic for review and complete groups on custom workflows', () => {
    expect(pickGroupTarget(customWorkflow, 'review')).toBe('beta_review');
    expect(pickGroupTarget(customWorkflow, 'complete')).toBe('omega');
  });
});
