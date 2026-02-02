import { describe, expect, it } from 'vitest';

import {
  extractCurrentPhase,
  extractWorkflowName,
  formatCompletionReason,
  formatLastError,
  formatPid,
  formatRunState,
  formatTimestamp,
  isValidViewMode,
  normalizeViewMode,
} from './WatchPage.js';

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

describe('formatRunState', () => {
  it('returns Running when running is true', () => {
    expect(formatRunState(true)).toBe('Running');
  });

  it('returns Idle when running is false', () => {
    expect(formatRunState(false)).toBe('Idle');
  });

  it('returns Idle when running is undefined', () => {
    expect(formatRunState(undefined)).toBe('Idle');
  });

  it('returns Idle when running is null', () => {
    expect(formatRunState(null)).toBe('Idle');
  });
});

describe('formatPid', () => {
  it('returns PID as string when present', () => {
    expect(formatPid(12345)).toBe('12345');
    expect(formatPid(1)).toBe('1');
    expect(formatPid(0)).toBe('0');
  });

  it('returns dash when PID is null', () => {
    expect(formatPid(null)).toBe('–');
  });

  it('returns dash when PID is undefined', () => {
    expect(formatPid(undefined)).toBe('–');
  });
});

describe('formatTimestamp', () => {
  it('returns formatted time for valid ISO timestamp', () => {
    // Use a fixed timestamp that will produce predictable output
    const timestamp = '2024-01-15T14:30:45.123Z';
    const result = formatTimestamp(timestamp);
    // Should produce a time string (exact format depends on locale)
    expect(result).not.toBe('–');
    expect(result).toMatch(/\d/); // Contains at least one digit
  });

  it('returns dash for null timestamp', () => {
    expect(formatTimestamp(null)).toBe('–');
  });

  it('returns dash for undefined timestamp', () => {
    expect(formatTimestamp(undefined)).toBe('–');
  });

  it('returns dash for empty string timestamp', () => {
    expect(formatTimestamp('')).toBe('–');
  });

  it('returns dash for invalid timestamp', () => {
    expect(formatTimestamp('not-a-date')).toBe('–');
  });
});

describe('formatCompletionReason', () => {
  it('returns reason when present', () => {
    expect(formatCompletionReason('success')).toBe('success');
    expect(formatCompletionReason('max_iterations')).toBe('max_iterations');
    expect(formatCompletionReason('user_cancelled')).toBe('user_cancelled');
  });

  it('returns null for null reason', () => {
    expect(formatCompletionReason(null)).toBeNull();
  });

  it('returns null for undefined reason', () => {
    expect(formatCompletionReason(undefined)).toBeNull();
  });

  it('returns null for empty string reason', () => {
    expect(formatCompletionReason('')).toBeNull();
  });
});

describe('formatLastError', () => {
  it('returns error when present and short', () => {
    expect(formatLastError('Connection failed')).toBe('Connection failed');
    expect(formatLastError('Error')).toBe('Error');
  });

  it('truncates long errors to 100 characters with ellipsis', () => {
    const longError = 'a'.repeat(150);
    const result = formatLastError(longError);
    expect(result).toHaveLength(101); // 100 chars + ellipsis
    expect(result).toBe('a'.repeat(100) + '…');
  });

  it('does not truncate errors at exactly 100 characters', () => {
    const exactError = 'a'.repeat(100);
    expect(formatLastError(exactError)).toBe(exactError);
  });

  it('returns null for null error', () => {
    expect(formatLastError(null)).toBeNull();
  });

  it('returns null for undefined error', () => {
    expect(formatLastError(undefined)).toBeNull();
  });

  it('returns null for empty string error', () => {
    expect(formatLastError('')).toBeNull();
  });
});

describe('run status fields update from stream state', () => {
  it('formatters work together to display run status from state snapshot', () => {
    // Simulate a run state snapshot from websocket
    const runStatus = {
      running: true,
      pid: 12345,
      started_at: '2024-01-15T10:00:00Z',
      ended_at: null,
      completion_reason: null,
      last_error: null,
    };

    expect(formatRunState(runStatus.running)).toBe('Running');
    expect(formatPid(runStatus.pid)).toBe('12345');
    expect(formatTimestamp(runStatus.started_at)).not.toBe('–');
    expect(formatTimestamp(runStatus.ended_at)).toBe('–');
    expect(formatCompletionReason(runStatus.completion_reason)).toBeNull();
    expect(formatLastError(runStatus.last_error)).toBeNull();
  });

  it('formatters handle completed run with error', () => {
    // Simulate a completed run with error
    const runStatus = {
      running: false,
      pid: 12345,
      started_at: '2024-01-15T10:00:00Z',
      ended_at: '2024-01-15T10:05:00Z',
      completion_reason: 'error',
      last_error: 'Process crashed unexpectedly',
    };

    expect(formatRunState(runStatus.running)).toBe('Idle');
    expect(formatPid(runStatus.pid)).toBe('12345');
    expect(formatTimestamp(runStatus.started_at)).not.toBe('–');
    expect(formatTimestamp(runStatus.ended_at)).not.toBe('–');
    expect(formatCompletionReason(runStatus.completion_reason)).toBe('error');
    expect(formatLastError(runStatus.last_error)).toBe('Process crashed unexpectedly');
  });

  it('formatters handle successful completed run', () => {
    // Simulate a successful completed run
    const runStatus = {
      running: false,
      pid: null, // PID may be null after process ends
      started_at: '2024-01-15T10:00:00Z',
      ended_at: '2024-01-15T10:30:00Z',
      completion_reason: 'max_iterations',
      last_error: null,
    };

    expect(formatRunState(runStatus.running)).toBe('Idle');
    expect(formatPid(runStatus.pid)).toBe('–');
    expect(formatTimestamp(runStatus.started_at)).not.toBe('–');
    expect(formatTimestamp(runStatus.ended_at)).not.toBe('–');
    expect(formatCompletionReason(runStatus.completion_reason)).toBe('max_iterations');
    expect(formatLastError(runStatus.last_error)).toBeNull();
  });
});
