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

  it('groups prepare_pr into review', () => {
    expect(groupForPhase('prepare_pr')).toBe('review');
  });

  it('groups complete into complete', () => {
    expect(groupForPhase('complete')).toBe('complete');
  });
});

describe('pickGroupTarget', () => {
  const workflow: WorkflowResponse = {
    ok: true,
    workflow_name: 'default',
    start_phase: 'design_draft',
    current_phase: 'design_draft',
    phases: [
      { id: 'design_draft', name: 'Design Draft', type: 'normal', description: '' },
      { id: 'implement_code', name: 'Implement Code', type: 'normal', description: '' },
      { id: 'prepare_pr', name: 'Prepare Pr', type: 'normal', description: '' },
      { id: 'complete', name: 'Complete', type: 'terminal', description: '' },
    ],
    phase_order: ['design_draft', 'implement_code', 'prepare_pr', 'complete'],
  };

  it('picks first design phase', () => {
    expect(pickGroupTarget(workflow, 'design')).toBe('design_draft');
  });

  it('picks first implement phase', () => {
    expect(pickGroupTarget(workflow, 'implement')).toBe('implement_code');
  });

  it('picks review phase', () => {
    expect(pickGroupTarget(workflow, 'review')).toBe('prepare_pr');
  });

  it('picks terminal/complete phase', () => {
    expect(pickGroupTarget(workflow, 'complete')).toBe('complete');
  });
});

