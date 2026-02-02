import { describe, expect, it } from 'vitest';

import type { IssueStateSnapshot, RunStatus } from '../api/types.js';
import type { ExtendedStreamState } from './streamReducer.js';
import { MAX_LOG_LINES, MAX_SDK_EVENTS, capArray, streamReducer } from './streamReducer.js';

function makeState(): ExtendedStreamState {
  return {
    connected: false,
    lastError: null,
    state: null,
    logs: [],
    viewerLogs: [],
    sdkEvents: [],
    runOverride: null,
    effectiveRun: null,
  };
}

function makeRunStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
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
    ...overrides,
  };
}

function makeStateSnapshot(overrides: Partial<IssueStateSnapshot> = {}): IssueStateSnapshot {
  return {
    issue_ref: 'owner/repo#1',
    paths: {
      dataDir: '/data',
      stateDir: '/state',
      workDir: '/work',
      workflowsDir: '/workflows',
      promptsDir: '/prompts',
    },
    issue_json: null,
    run: makeRunStatus(),
    ...overrides,
  };
}

describe('capArray', () => {
  it('keeps the last N items', () => {
    expect(capArray([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });
});

describe('streamReducer logs', () => {
  it('appends logs by default', () => {
    const s1 = makeState();
    const s2 = streamReducer(s1, { type: 'logs', data: { lines: ['a'] } });
    const s3 = streamReducer(s2, { type: 'logs', data: { lines: ['b'] } });
    expect(s3.logs).toEqual(['a', 'b']);
  });

  it('resets logs when reset=true', () => {
    const s1 = makeState();
    const s2 = streamReducer(s1, { type: 'logs', data: { lines: ['a', 'b'] } });
    const s3 = streamReducer(s2, { type: 'logs', data: { lines: ['x'], reset: true } });
    expect(s3.logs).toEqual(['x']);
  });
});

describe('streamReducer sdk', () => {
  it('caps sdk events', () => {
    let state = makeState();
    for (let i = 0; i < MAX_SDK_EVENTS + 10; i += 1) {
      state = streamReducer(state, { type: 'sdk', event: 'e', data: { i } });
    }
    expect(state.sdkEvents.length).toBe(MAX_SDK_EVENTS);
    expect(state.sdkEvents[0]?.data).toEqual({ i: 10 });
  });
});

describe('streamReducer log capping', () => {
  it('caps log lines', () => {
    let state = makeState();
    for (let i = 0; i < MAX_LOG_LINES + 5; i += 1) {
      state = streamReducer(state, { type: 'logs', data: { lines: [`${i}`] } });
    }
    expect(state.logs.length).toBe(MAX_LOG_LINES);
    expect(state.logs[0]).toBe('5');
  });
});

describe('streamReducer run/state ordering', () => {
  it('stores run update in runOverride before first state snapshot', () => {
    const s1 = makeState();
    const runUpdate = makeRunStatus({ running: true, current_iteration: 3 });
    const s2 = streamReducer(s1, { type: 'run', data: { run: runUpdate } });

    expect(s2.runOverride).toEqual(runUpdate);
    expect(s2.effectiveRun).toEqual(runUpdate);
    expect(s2.state).toBeNull(); // No placeholder snapshot created
  });

  it('run -> state: snapshot clears runOverride (snapshot wins)', () => {
    const s1 = makeState();
    // First: run update arrives
    const runUpdate = makeRunStatus({ running: true, current_iteration: 5 });
    const s2 = streamReducer(s1, { type: 'run', data: { run: runUpdate } });
    expect(s2.runOverride).toEqual(runUpdate);
    expect(s2.effectiveRun).toEqual(runUpdate);

    // Then: state snapshot arrives - should clear runOverride
    const snapshot = makeStateSnapshot({
      run: makeRunStatus({ running: true, current_iteration: 6 }),
    });
    const s3 = streamReducer(s2, { type: 'state', data: snapshot });

    expect(s3.runOverride).toBeNull(); // Cleared
    expect(s3.state).toEqual(snapshot); // Snapshot supersedes
    expect(s3.state?.run.current_iteration).toBe(6);
    expect(s3.effectiveRun).toEqual(snapshot.run); // effectiveRun reflects snapshot
  });

  it('state -> run: run update sets runOverride and updates state.run (run wins until next snapshot)', () => {
    const s1 = makeState();
    // First: state snapshot arrives
    const snapshot = makeStateSnapshot({
      run: makeRunStatus({ running: true, current_iteration: 2 }),
    });
    const s2 = streamReducer(s1, { type: 'state', data: snapshot });
    expect(s2.state?.run.current_iteration).toBe(2);
    expect(s2.runOverride).toBeNull();
    expect(s2.effectiveRun).toEqual(snapshot.run);

    // Then: run update arrives - should set runOverride AND update state.run
    const runUpdate = makeRunStatus({ running: true, current_iteration: 4 });
    const s3 = streamReducer(s2, { type: 'run', data: { run: runUpdate } });

    expect(s3.runOverride).toEqual(runUpdate);
    // state.run is also updated so UI consumers reading state.run see live updates
    expect(s3.state?.run.current_iteration).toBe(4);
    expect(s3.state?.run).toEqual(runUpdate);
    // effectiveRun reflects the live run update
    expect(s3.effectiveRun).toEqual(runUpdate);
    expect(s3.effectiveRun?.current_iteration).toBe(4);
  });

  it('multiple run updates: last run wins', () => {
    const s1 = makeState();
    const run1 = makeRunStatus({ current_iteration: 1 });
    const run2 = makeRunStatus({ current_iteration: 2 });
    const run3 = makeRunStatus({ current_iteration: 3 });

    let state = streamReducer(s1, { type: 'run', data: { run: run1 } });
    state = streamReducer(state, { type: 'run', data: { run: run2 } });
    state = streamReducer(state, { type: 'run', data: { run: run3 } });

    expect(state.runOverride?.current_iteration).toBe(3);
    expect(state.effectiveRun?.current_iteration).toBe(3);
  });

  it('run -> state -> run: second run update re-establishes override and updates state.run', () => {
    const s1 = makeState();

    // run update (no state yet, so state remains null)
    const run1 = makeRunStatus({ current_iteration: 1 });
    let state = streamReducer(s1, { type: 'run', data: { run: run1 } });
    expect(state.runOverride?.current_iteration).toBe(1);
    expect(state.effectiveRun?.current_iteration).toBe(1);
    expect(state.state).toBeNull(); // No state yet

    // state snapshot clears override
    const snapshot = makeStateSnapshot({
      run: makeRunStatus({ current_iteration: 2 }),
    });
    state = streamReducer(state, { type: 'state', data: snapshot });
    expect(state.runOverride).toBeNull();
    expect(state.state?.run.current_iteration).toBe(2);
    expect(state.effectiveRun?.current_iteration).toBe(2);

    // another run update re-establishes override AND updates state.run
    const run2 = makeRunStatus({ current_iteration: 5 });
    state = streamReducer(state, { type: 'run', data: { run: run2 } });
    expect(state.runOverride?.current_iteration).toBe(5);
    expect(state.state?.run.current_iteration).toBe(5); // state.run is updated for UI consumers
    expect(state.state?.run).toEqual(run2);
    expect(state.effectiveRun?.current_iteration).toBe(5); // effectiveRun reflects live update
  });
});

