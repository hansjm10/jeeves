import { describe, expect, it } from 'vitest';

import type { RunStatus } from './types.js';
import { resolveWorkerArtifactsRunId } from './workerArtifacts.js';

function makeRunStatus(overrides?: Partial<RunStatus>): RunStatus {
  return {
    run_id: null,
    run_dir: null,
    running: false,
    pid: null,
    started_at: null,
    ended_at: null,
    returncode: null,
    command: null,
    max_iterations: 10,
    current_iteration: 0,
    completed_via_promise: false,
    completed_via_state: false,
    completion_reason: null,
    last_error: null,
    issue_ref: null,
    viewer_log_file: null,
    workers: null,
    max_parallel_tasks: null,
    ...overrides,
  };
}

describe('workerArtifacts', () => {
  describe('resolveWorkerArtifactsRunId', () => {
    it('prefers issue.json.status.parallel.runId over run.run_id', () => {
      const run = makeRunStatus({ run_id: 'run-new' });
      const issueJson = { status: { parallel: { runId: 'run-old' } } };
      expect(resolveWorkerArtifactsRunId({ run, issueJson })).toBe('run-old');
    });

    it('falls back to run.run_id when no parallel state is present', () => {
      const run = makeRunStatus({ run_id: 'run-123' });
      expect(resolveWorkerArtifactsRunId({ run, issueJson: null })).toBe('run-123');
      expect(resolveWorkerArtifactsRunId({ run, issueJson: { status: {} } })).toBe('run-123');
    });

    it('trims whitespace in run ids', () => {
      const run = makeRunStatus({ run_id: '  run-123  ' });
      const issueJson = { status: { parallel: { runId: '  run-999 ' } } };
      expect(resolveWorkerArtifactsRunId({ run, issueJson })).toBe('run-999');
      expect(resolveWorkerArtifactsRunId({ run, issueJson: { status: {} } })).toBe('run-123');
    });

    it('returns null when neither parallel runId nor run.run_id is available', () => {
      const run = makeRunStatus({ run_id: null });
      const issueJson = { status: { parallel: { runId: '' } } };
      expect(resolveWorkerArtifactsRunId({ run, issueJson })).toBeNull();
    });
  });
});

