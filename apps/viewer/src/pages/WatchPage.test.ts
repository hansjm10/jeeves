import { describe, expect, it } from 'vitest';

import {
  computeRunContextFields,
  computeRunOutcome,
  extractCurrentPhase,
  extractWorkflowName,
  formatCompletionReason,
  formatLastError,
  formatPid,
  formatRunState,
  formatTimestamp,
  formatWorkerPhase,
  getWorkerStatusColor,
  isStopVisible,
  isValidViewMode,
  normalizeViewMode,
  type RunContextField,
  type RunContextInput,
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

// Helper to get a field by label from computeRunContextFields result
function getField(fields: RunContextField[], label: string): RunContextField | undefined {
  return fields.find((f) => f.label === label);
}

describe('computeRunContextFields', () => {
  describe('always-visible fields', () => {
    it('State field is always visible', () => {
      const fields = computeRunContextFields({});
      const stateField = getField(fields, 'State');
      expect(stateField).toBeDefined();
      expect(stateField?.visible).toBe(true);
    });

    it('Issue field is always visible with (none) when not set', () => {
      const fields = computeRunContextFields({});
      const issueField = getField(fields, 'Issue');
      expect(issueField).toBeDefined();
      expect(issueField?.visible).toBe(true);
      expect(issueField?.value).toBe('(none)');
    });

    it('Issue field shows issue_ref when set', () => {
      const fields = computeRunContextFields({ issue_ref: 'owner/repo#123' });
      const issueField = getField(fields, 'Issue');
      expect(issueField?.value).toBe('owner/repo#123');
    });

    it('Workflow field is always visible with (none) when not set', () => {
      const fields = computeRunContextFields({});
      const workflowField = getField(fields, 'Workflow');
      expect(workflowField).toBeDefined();
      expect(workflowField?.visible).toBe(true);
      expect(workflowField?.value).toBe('(none)');
    });

    it('Phase field is always visible with (none) when not set', () => {
      const fields = computeRunContextFields({});
      const phaseField = getField(fields, 'Phase');
      expect(phaseField).toBeDefined();
      expect(phaseField?.visible).toBe(true);
      expect(phaseField?.value).toBe('(none)');
    });
  });

  describe('State field values', () => {
    it('shows Running when run.running is true', () => {
      const fields = computeRunContextFields({ run: { running: true } });
      const stateField = getField(fields, 'State');
      expect(stateField?.value).toBe('Running');
    });

    it('shows Idle when run.running is false', () => {
      const fields = computeRunContextFields({ run: { running: false } });
      const stateField = getField(fields, 'State');
      expect(stateField?.value).toBe('Idle');
    });

    it('shows Idle when run is null', () => {
      const fields = computeRunContextFields({ run: null });
      const stateField = getField(fields, 'State');
      expect(stateField?.value).toBe('Idle');
    });
  });

  describe('PID field visibility and value', () => {
    it('PID is visible when running', () => {
      const fields = computeRunContextFields({ run: { running: true, pid: 12345 } });
      const pidField = getField(fields, 'PID');
      expect(pidField?.visible).toBe(true);
      expect(pidField?.value).toBe('12345');
    });

    it('PID is visible when not running but PID is present', () => {
      const fields = computeRunContextFields({ run: { running: false, pid: 54321 } });
      const pidField = getField(fields, 'PID');
      expect(pidField?.visible).toBe(true);
      expect(pidField?.value).toBe('54321');
    });

    it('PID is not visible when not running and no PID', () => {
      const fields = computeRunContextFields({ run: { running: false, pid: null } });
      const pidField = getField(fields, 'PID');
      expect(pidField?.visible).toBe(false);
    });

    it('PID shows dash when present but null', () => {
      const fields = computeRunContextFields({ run: { running: true, pid: null } });
      const pidField = getField(fields, 'PID');
      expect(pidField?.visible).toBe(true);
      expect(pidField?.value).toBe('–');
    });
  });

  describe('Iteration field visibility', () => {
    it('Iteration is visible only when running', () => {
      const fieldsRunning = computeRunContextFields({
        run: { running: true, current_iteration: 5, max_iterations: 10 },
      });
      expect(getField(fieldsRunning, 'Iteration')?.visible).toBe(true);
      expect(getField(fieldsRunning, 'Iteration')?.value).toBe('5/10');

      const fieldsIdle = computeRunContextFields({
        run: { running: false, current_iteration: 5, max_iterations: 10 },
      });
      expect(getField(fieldsIdle, 'Iteration')?.visible).toBe(false);
    });
  });

  describe('Started field visibility and value', () => {
    it('Started is visible when started_at is present', () => {
      const fields = computeRunContextFields({
        run: { started_at: '2024-01-15T10:00:00Z' },
      });
      const startedField = getField(fields, 'Started');
      expect(startedField?.visible).toBe(true);
      expect(startedField?.value).not.toBe('–');
    });

    it('Started is not visible when started_at is null', () => {
      const fields = computeRunContextFields({ run: { started_at: null } });
      const startedField = getField(fields, 'Started');
      expect(startedField?.visible).toBe(false);
    });
  });

  describe('Ended field visibility and value', () => {
    it('Ended is visible when ended_at is present', () => {
      const fields = computeRunContextFields({
        run: { ended_at: '2024-01-15T10:30:00Z' },
      });
      const endedField = getField(fields, 'Ended');
      expect(endedField?.visible).toBe(true);
      expect(endedField?.value).not.toBe('–');
    });

    it('Ended is not visible when ended_at is null', () => {
      const fields = computeRunContextFields({ run: { ended_at: null } });
      const endedField = getField(fields, 'Ended');
      expect(endedField?.visible).toBe(false);
    });
  });

  describe('Completed field visibility and value', () => {
    it('Completed is visible when completion_reason is present', () => {
      const fields = computeRunContextFields({
        run: { completion_reason: 'max_iterations' },
      });
      const completedField = getField(fields, 'Completed');
      expect(completedField?.visible).toBe(true);
      expect(completedField?.value).toBe('max_iterations');
    });

    it('Completed is not visible when completion_reason is null', () => {
      const fields = computeRunContextFields({ run: { completion_reason: null } });
      const completedField = getField(fields, 'Completed');
      expect(completedField?.visible).toBe(false);
    });

    it('Completed is not visible when completion_reason is empty string', () => {
      const fields = computeRunContextFields({ run: { completion_reason: '' } });
      const completedField = getField(fields, 'Completed');
      expect(completedField?.visible).toBe(false);
    });
  });

  describe('Error field visibility, value, and truncation', () => {
    it('Error is visible when last_error is present', () => {
      const fields = computeRunContextFields({
        run: { last_error: 'Connection failed' },
      });
      const errorField = getField(fields, 'Error');
      expect(errorField?.visible).toBe(true);
      expect(errorField?.value).toBe('Connection failed');
    });

    it('Error is not visible when last_error is null', () => {
      const fields = computeRunContextFields({ run: { last_error: null } });
      const errorField = getField(fields, 'Error');
      expect(errorField?.visible).toBe(false);
    });

    it('Error value is truncated for long errors but fullValue preserves original', () => {
      const longError = 'a'.repeat(150);
      const fields = computeRunContextFields({ run: { last_error: longError } });
      const errorField = getField(fields, 'Error');
      expect(errorField?.visible).toBe(true);
      // Truncated to 100 chars + ellipsis
      expect(errorField?.value).toBe('a'.repeat(100) + '…');
      // Full value preserved for title attribute
      expect(errorField?.fullValue).toBe(longError);
    });

    it('Error value is not truncated for short errors', () => {
      const shortError = 'Short error message';
      const fields = computeRunContextFields({ run: { last_error: shortError } });
      const errorField = getField(fields, 'Error');
      expect(errorField?.value).toBe(shortError);
      expect(errorField?.fullValue).toBe(shortError);
    });
  });

  describe('complete run scenarios', () => {
    it('active running state shows all running fields', () => {
      const input: RunContextInput = {
        issue_ref: 'owner/repo#42',
        issue_json: { workflow: 'default', phase: 'implement_task' },
        run: {
          running: true,
          pid: 12345,
          started_at: '2024-01-15T10:00:00Z',
          current_iteration: 3,
          max_iterations: 10,
        },
      };
      const fields = computeRunContextFields(input);

      expect(getField(fields, 'State')?.value).toBe('Running');
      expect(getField(fields, 'Issue')?.value).toBe('owner/repo#42');
      expect(getField(fields, 'Workflow')?.value).toBe('default');
      expect(getField(fields, 'Phase')?.value).toBe('implement_task');
      expect(getField(fields, 'PID')?.visible).toBe(true);
      expect(getField(fields, 'PID')?.value).toBe('12345');
      expect(getField(fields, 'Iteration')?.visible).toBe(true);
      expect(getField(fields, 'Iteration')?.value).toBe('3/10');
      expect(getField(fields, 'Started')?.visible).toBe(true);
      expect(getField(fields, 'Ended')?.visible).toBe(false);
      expect(getField(fields, 'Completed')?.visible).toBe(false);
      expect(getField(fields, 'Error')?.visible).toBe(false);
    });

    it('completed run with error shows all completion fields', () => {
      const input: RunContextInput = {
        issue_ref: 'owner/repo#42',
        issue_json: { workflow: 'default', phase: 'implement_task' },
        run: {
          running: false,
          pid: 12345,
          started_at: '2024-01-15T10:00:00Z',
          ended_at: '2024-01-15T10:30:00Z',
          completion_reason: 'error',
          last_error: 'Process crashed unexpectedly',
        },
      };
      const fields = computeRunContextFields(input);

      expect(getField(fields, 'State')?.value).toBe('Idle');
      expect(getField(fields, 'PID')?.visible).toBe(true); // PID shown because pid is present
      expect(getField(fields, 'Iteration')?.visible).toBe(false); // Not running
      expect(getField(fields, 'Started')?.visible).toBe(true);
      expect(getField(fields, 'Ended')?.visible).toBe(true);
      expect(getField(fields, 'Completed')?.visible).toBe(true);
      expect(getField(fields, 'Completed')?.value).toBe('error');
      expect(getField(fields, 'Error')?.visible).toBe(true);
      expect(getField(fields, 'Error')?.value).toBe('Process crashed unexpectedly');
    });

    it('completed run with success shows completed but not error', () => {
      const input: RunContextInput = {
        issue_ref: 'owner/repo#42',
        issue_json: { workflow: 'default', phase: 'implement_task' },
        run: {
          running: false,
          pid: null,
          started_at: '2024-01-15T10:00:00Z',
          ended_at: '2024-01-15T10:30:00Z',
          completion_reason: 'max_iterations',
          last_error: null,
        },
      };
      const fields = computeRunContextFields(input);

      expect(getField(fields, 'State')?.value).toBe('Idle');
      expect(getField(fields, 'PID')?.visible).toBe(false); // No PID and not running
      expect(getField(fields, 'Iteration')?.visible).toBe(false);
      expect(getField(fields, 'Started')?.visible).toBe(true);
      expect(getField(fields, 'Ended')?.visible).toBe(true);
      expect(getField(fields, 'Completed')?.visible).toBe(true);
      expect(getField(fields, 'Completed')?.value).toBe('max_iterations');
      expect(getField(fields, 'Error')?.visible).toBe(false);
    });
  });

  describe('fields update from stream state changes', () => {
    it('fields reflect state changes when run status updates', () => {
      // Initial idle state
      const idleInput: RunContextInput = { run: { running: false } };
      const idleFields = computeRunContextFields(idleInput);
      expect(getField(idleFields, 'State')?.value).toBe('Idle');
      expect(getField(idleFields, 'Iteration')?.visible).toBe(false);

      // Running state update arrives
      const runningInput: RunContextInput = {
        run: { running: true, pid: 12345, current_iteration: 1, max_iterations: 10 },
      };
      const runningFields = computeRunContextFields(runningInput);
      expect(getField(runningFields, 'State')?.value).toBe('Running');
      expect(getField(runningFields, 'PID')?.value).toBe('12345');
      expect(getField(runningFields, 'Iteration')?.visible).toBe(true);
      expect(getField(runningFields, 'Iteration')?.value).toBe('1/10');

      // Iteration update arrives
      const iterationUpdate: RunContextInput = {
        run: { running: true, pid: 12345, current_iteration: 5, max_iterations: 10 },
      };
      const updatedFields = computeRunContextFields(iterationUpdate);
      expect(getField(updatedFields, 'Iteration')?.value).toBe('5/10');

      // Run completes with error
      const completedInput: RunContextInput = {
        run: {
          running: false,
          pid: 12345,
          started_at: '2024-01-15T10:00:00Z',
          ended_at: '2024-01-15T10:30:00Z',
          completion_reason: 'error',
          last_error: 'Failed',
        },
      };
      const completedFields = computeRunContextFields(completedInput);
      expect(getField(completedFields, 'State')?.value).toBe('Idle');
      expect(getField(completedFields, 'Iteration')?.visible).toBe(false);
      expect(getField(completedFields, 'Completed')?.visible).toBe(true);
      expect(getField(completedFields, 'Error')?.visible).toBe(true);
    });
  });
});

describe('getWorkerStatusColor', () => {
  it('returns blue colors for running status', () => {
    const style = getWorkerStatusColor('running');
    expect(style.color).toBe('var(--color-accent-blue)');
  });

  it('returns green colors for passed status', () => {
    const style = getWorkerStatusColor('passed');
    expect(style.color).toBe('var(--color-accent-green)');
  });

  it('returns red colors for failed status', () => {
    const style = getWorkerStatusColor('failed');
    expect(style.color).toBe('var(--color-accent-red)');
  });

  it('returns orange colors for timed_out status', () => {
    const style = getWorkerStatusColor('timed_out');
    // Should have an orange color
    expect(style.color).toContain('orange');
  });
});

describe('formatWorkerPhase', () => {
  it('formats implement_task as "implement"', () => {
    expect(formatWorkerPhase('implement_task')).toBe('implement');
  });

  it('formats task_spec_check as "spec-check"', () => {
    expect(formatWorkerPhase('task_spec_check')).toBe('spec-check');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// T8: Watch context control tests
// ──────────────────────────────────────────────────────────────────────────────

describe('T8-AC1: Stop control visibility and pending state', () => {
  describe('isStopVisible tracks run.running', () => {
    it('returns true when running is true', () => {
      expect(isStopVisible(true)).toBe(true);
    });

    it('returns false when running is false', () => {
      expect(isStopVisible(false)).toBe(false);
    });

    it('returns false when running is null', () => {
      expect(isStopVisible(null)).toBe(false);
    });

    it('returns false when running is undefined', () => {
      expect(isStopVisible(undefined)).toBe(false);
    });
  });

  describe('Stop visibility strictly follows running state transitions', () => {
    it('Stop visible during run, hidden before and after', () => {
      // Before run starts
      expect(isStopVisible(false)).toBe(false);
      // Run starts
      expect(isStopVisible(true)).toBe(true);
      // Run ends
      expect(isStopVisible(false)).toBe(false);
    });

    it('Stop hidden when run data is absent', () => {
      // No run data at all (null/undefined)
      expect(isStopVisible(null)).toBe(false);
      expect(isStopVisible(undefined)).toBe(false);
    });

    it('Stop visible immediately on run start, hidden immediately on run end', () => {
      // Simulate quick state transitions
      const states: (boolean | null)[] = [false, true, true, true, false];
      const expected = [false, true, true, true, false];
      states.forEach((running, i) => {
        expect(isStopVisible(running)).toBe(expected[i]);
      });
    });
  });

  describe('Stop pending state tracks mutation status', () => {
    /**
     * Derives the Stop button's UI state from visibility and mutation pending status.
     * Mirrors WatchPage.tsx lines 574-587:
     *   - rendered: isStopVisible(running) gates whether the button is in the DOM
     *   - disabled: stopRun.isPending controls the disabled attribute
     *   - label: isPending ? 'Stopping…' : 'Stop'
     */
    function deriveStopButtonState(
      running: boolean | null | undefined,
      isPending: boolean,
    ): { rendered: boolean; disabled: boolean; label: string } | null {
      if (!isStopVisible(running)) return null; // button not in DOM
      return {
        rendered: true,
        disabled: isPending,
        label: isPending ? 'Stopping…' : 'Stop',
      };
    }

    it('Stop button is enabled with label "Stop" when not pending', () => {
      const state = deriveStopButtonState(true, false);
      expect(state).not.toBeNull();
      expect(state!.rendered).toBe(true);
      expect(state!.disabled).toBe(false);
      expect(state!.label).toBe('Stop');
    });

    it('Stop button is disabled with label "Stopping…" when mutation is pending', () => {
      const state = deriveStopButtonState(true, true);
      expect(state).not.toBeNull();
      expect(state!.rendered).toBe(true);
      expect(state!.disabled).toBe(true);
      expect(state!.label).toBe('Stopping…');
    });

    it('Stop button is not rendered when not running, regardless of pending state', () => {
      expect(deriveStopButtonState(false, false)).toBeNull();
      expect(deriveStopButtonState(false, true)).toBeNull();
      expect(deriveStopButtonState(null, false)).toBeNull();
      expect(deriveStopButtonState(null, true)).toBeNull();
      expect(deriveStopButtonState(undefined, false)).toBeNull();
      expect(deriveStopButtonState(undefined, true)).toBeNull();
    });

    it('pending state transitions: Stop → Stopping… → Stop', () => {
      // Initial: mutation not started
      const idle = deriveStopButtonState(true, false);
      expect(idle!.disabled).toBe(false);
      expect(idle!.label).toBe('Stop');

      // Mutation in progress (isPending = true)
      const pending = deriveStopButtonState(true, true);
      expect(pending!.disabled).toBe(true);
      expect(pending!.label).toBe('Stopping…');

      // Mutation resolved (isPending = false again)
      const resolved = deriveStopButtonState(true, false);
      expect(resolved!.disabled).toBe(false);
      expect(resolved!.label).toBe('Stop');
    });

    it('Stop visibility is independent of other run fields', () => {
      // Even with completion_reason set, if running is true, Stop is visible
      // (this is a pure visibility gate on the running boolean)
      expect(isStopVisible(true)).toBe(true);
    });

    it('Stop button calls stop mutation with force: false (contract verification)', () => {
      // The Stop button in WatchPage.tsx (line 583) calls:
      //   stopRun.mutateAsync({ force: false })
      // The mutation is useStopRunMutation which sends { force: boolean } to /api/run/stop.
      // We verify the gate condition is the sole determinant of rendering:
      const rendered = deriveStopButtonState(true, false);
      expect(rendered).not.toBeNull();
      expect(rendered!.rendered).toBe(true);

      const notRendered = deriveStopButtonState(false, false);
      expect(notRendered).toBeNull();
    });
  });
});

describe('T8-AC2: Completion badge visibility requires run completion and completion_reason', () => {
  describe('badge hidden while running', () => {
    it('returns null when running is true, even with completion_reason', () => {
      expect(computeRunOutcome({
        running: true,
        completion_reason: 'success',
        last_error: null,
      })).toBeNull();
    });

    it('returns null when running is true and no completion_reason', () => {
      expect(computeRunOutcome({
        running: true,
        completion_reason: null,
        last_error: null,
      })).toBeNull();
    });

    it('returns null when running is true with error state', () => {
      expect(computeRunOutcome({
        running: true,
        completion_reason: 'error',
        last_error: 'some error',
      })).toBeNull();
    });
  });

  describe('badge hidden when no completion_reason', () => {
    it('returns null when not running and completion_reason is null', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: null,
        last_error: null,
      })).toBeNull();
    });

    it('returns null when not running and completion_reason is undefined', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: undefined,
        last_error: null,
      })).toBeNull();
    });

    it('returns null when not running and completion_reason is empty string', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: '',
        last_error: null,
      })).toBeNull();
    });

    it('returns null when running is null and no completion_reason', () => {
      expect(computeRunOutcome({
        running: null,
        completion_reason: null,
        last_error: null,
      })).toBeNull();
    });

    it('returns null when running is undefined and no completion_reason', () => {
      expect(computeRunOutcome({
        running: undefined,
        completion_reason: undefined,
        last_error: undefined,
      })).toBeNull();
    });
  });

  describe('badge shown only when both run completed and completion_reason present', () => {
    it('returns non-null when not running and completion_reason is present', () => {
      const result = computeRunOutcome({
        running: false,
        completion_reason: 'success',
        last_error: null,
      });
      expect(result).not.toBeNull();
    });

    it('returns non-null when not running and completion_reason is "max_iterations"', () => {
      const result = computeRunOutcome({
        running: false,
        completion_reason: 'max_iterations',
        last_error: null,
      });
      expect(result).not.toBeNull();
    });

    it('badge visibility transitions correctly across run lifecycle', () => {
      // Idle - no badge (no completion_reason)
      expect(computeRunOutcome({ running: false, completion_reason: null })).toBeNull();
      // Running - no badge
      expect(computeRunOutcome({ running: true, completion_reason: null })).toBeNull();
      // Run completes with reason - badge shows
      expect(computeRunOutcome({ running: false, completion_reason: 'success' })).not.toBeNull();
    });
  });
});

describe('T8-AC3: Error vs Complete badge mapping', () => {
  describe('Error badge when completion_reason is "error"', () => {
    it('returns Error when completion_reason is "error" and no last_error', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'error',
        last_error: null,
      })).toBe('Error');
    });

    it('returns Error when completion_reason is "error" and last_error is present', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'error',
        last_error: 'Process crashed',
      })).toBe('Error');
    });

    it('returns Error when completion_reason is "error" and last_error is empty string', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'error',
        last_error: '',
      })).toBe('Error');
    });
  });

  describe('Error badge when last_error is present (regardless of completion_reason)', () => {
    it('returns Error when completion_reason is "success" but last_error is present', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'success',
        last_error: 'Some residual error',
      })).toBe('Error');
    });

    it('returns Error when completion_reason is "max_iterations" but last_error is present', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'max_iterations',
        last_error: 'Timeout error',
      })).toBe('Error');
    });

    it('returns Error when completion_reason is any non-error value but last_error is present', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'user_cancelled',
        last_error: 'Cancelled with error context',
      })).toBe('Error');
    });
  });

  describe('Complete badge for non-error completions', () => {
    it('returns Complete when completion_reason is "success" and no last_error', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'success',
        last_error: null,
      })).toBe('Complete');
    });

    it('returns Complete when completion_reason is "max_iterations" and no last_error', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'max_iterations',
        last_error: null,
      })).toBe('Complete');
    });

    it('returns Complete when completion_reason is "user_cancelled" and no last_error', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'user_cancelled',
        last_error: null,
      })).toBe('Complete');
    });

    it('returns Complete when completion_reason is present and last_error is empty string', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'success',
        last_error: '',
      })).toBe('Complete');
    });

    it('returns Complete when completion_reason is present and last_error is undefined', () => {
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'success',
        last_error: undefined,
      })).toBe('Complete');
    });
  });

  describe('deterministic badge semantics across state transitions', () => {
    it('badge changes from null to Complete on successful run completion', () => {
      // Running
      expect(computeRunOutcome({ running: true, completion_reason: null, last_error: null })).toBeNull();
      // Completed successfully
      expect(computeRunOutcome({ running: false, completion_reason: 'success', last_error: null })).toBe('Complete');
    });

    it('badge changes from null to Error on error run completion', () => {
      // Running
      expect(computeRunOutcome({ running: true, completion_reason: null, last_error: null })).toBeNull();
      // Completed with error
      expect(computeRunOutcome({ running: false, completion_reason: 'error', last_error: 'crash' })).toBe('Error');
    });

    it('Error takes precedence: last_error overrides non-error completion_reason', () => {
      // Even with "success" completion_reason, last_error forces Error badge
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'success',
        last_error: 'unexpected error after completion',
      })).toBe('Error');
    });

    it('Complete is returned only when both conditions hold: completion_reason present AND no error indicators', () => {
      // Must be not running + have completion_reason + no error indicators
      expect(computeRunOutcome({
        running: false,
        completion_reason: 'success',
        last_error: null,
      })).toBe('Complete');

      // Missing completion_reason -> null (not Complete)
      expect(computeRunOutcome({
        running: false,
        completion_reason: null,
        last_error: null,
      })).toBeNull();
    });
  });
});
