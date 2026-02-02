import { describe, expect, it } from 'vitest';

import { extractCurrentPhase, extractWorkflowName, isValidViewMode, normalizeViewMode } from './WatchPage.js';

describe('extractWorkflowName', () => {
  it('returns null for null issue_json', () => {
    expect(extractWorkflowName(null)).toBeNull();
  });

  it('returns null for undefined issue_json', () => {
    expect(extractWorkflowName(undefined)).toBeNull();
  });

  it('returns null when workflow field is missing', () => {
    expect(extractWorkflowName({})).toBeNull();
  });

  it('returns null when workflow is not a string', () => {
    expect(extractWorkflowName({ workflow: 123 })).toBeNull();
    expect(extractWorkflowName({ workflow: null })).toBeNull();
    expect(extractWorkflowName({ workflow: {} })).toBeNull();
  });

  it('returns workflow name when it is a string', () => {
    expect(extractWorkflowName({ workflow: 'default' })).toBe('default');
    expect(extractWorkflowName({ workflow: 'custom-workflow' })).toBe('custom-workflow');
  });
});

describe('extractCurrentPhase', () => {
  it('returns null for null issue_json', () => {
    expect(extractCurrentPhase(null)).toBeNull();
  });

  it('returns null for undefined issue_json', () => {
    expect(extractCurrentPhase(undefined)).toBeNull();
  });

  it('returns null when phase field is missing', () => {
    expect(extractCurrentPhase({})).toBeNull();
  });

  it('returns null when phase is not a string', () => {
    expect(extractCurrentPhase({ phase: 123 })).toBeNull();
    expect(extractCurrentPhase({ phase: null })).toBeNull();
    expect(extractCurrentPhase({ phase: [] })).toBeNull();
  });

  it('returns phase when it is a string', () => {
    expect(extractCurrentPhase({ phase: 'design_draft' })).toBe('design_draft');
    expect(extractCurrentPhase({ phase: 'implement_task' })).toBe('implement_task');
  });
});

describe('workflow/phase live update semantics', () => {
  it('extractWorkflowName and extractCurrentPhase work together for live state updates', () => {
    // Simulate initial state snapshot
    const initialState = {
      workflow: 'default',
      phase: 'design_draft',
    };
    expect(extractWorkflowName(initialState)).toBe('default');
    expect(extractCurrentPhase(initialState)).toBe('design_draft');

    // Simulate updated state snapshot (phase changed)
    const updatedState = {
      workflow: 'default',
      phase: 'implement_task',
    };
    expect(extractWorkflowName(updatedState)).toBe('default');
    expect(extractCurrentPhase(updatedState)).toBe('implement_task');

    // Simulate another update (workflow changed)
    const anotherUpdate = {
      workflow: 'custom',
      phase: 'review',
    };
    expect(extractWorkflowName(anotherUpdate)).toBe('custom');
    expect(extractCurrentPhase(anotherUpdate)).toBe('review');
  });

  it('handles state transition from null to populated issue_json', () => {
    // Initial null state
    expect(extractWorkflowName(null)).toBeNull();
    expect(extractCurrentPhase(null)).toBeNull();

    // State snapshot arrives
    const state = { workflow: 'default', phase: 'start' };
    expect(extractWorkflowName(state)).toBe('default');
    expect(extractCurrentPhase(state)).toBe('start');
  });
});

describe('isValidViewMode', () => {
  it('returns true for valid view modes', () => {
    expect(isValidViewMode('combined')).toBe(true);
    expect(isValidViewMode('sdk')).toBe(true);
    expect(isValidViewMode('logs')).toBe(true);
    expect(isValidViewMode('viewer-logs')).toBe(true);
  });

  it('returns false for invalid view modes', () => {
    expect(isValidViewMode('invalid')).toBe(false);
    expect(isValidViewMode('')).toBe(false);
    expect(isValidViewMode(null)).toBe(false);
  });
});

describe('normalizeViewMode', () => {
  it('returns the view if valid', () => {
    expect(normalizeViewMode('combined')).toBe('combined');
    expect(normalizeViewMode('sdk')).toBe('sdk');
    expect(normalizeViewMode('logs')).toBe('logs');
    expect(normalizeViewMode('viewer-logs')).toBe('viewer-logs');
  });

  it('returns combined for invalid views', () => {
    expect(normalizeViewMode('invalid')).toBe('combined');
    expect(normalizeViewMode('')).toBe('combined');
    expect(normalizeViewMode(null)).toBe('combined');
  });
});
