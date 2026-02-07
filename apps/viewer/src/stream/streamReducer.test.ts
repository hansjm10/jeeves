import { describe, expect, it } from 'vitest';

import type {
  IssueStateSnapshot,
  RunStatus,
  SonarTokenStatusEvent,
  AzureDevopsStatusEvent,
  IssueIngestStatusEvent,
  ProjectFilesStatusEvent,
} from '../api/types.js';
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
    workerLogs: {},
    workerSdkEvents: {},
    runOverride: null,
    effectiveRun: null,
    sonarTokenStatus: null,
    azureDevopsStatus: null,
    issueIngestStatus: null,
    projectFilesStatus: null,
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

describe('streamReducer workflow/phase live updates via state events', () => {
  it('state event updates issue_json with workflow/phase', () => {
    const s1 = makeState();

    // First state snapshot with workflow/phase
    const snapshot1 = makeStateSnapshot({
      issue_json: { workflow: 'default', phase: 'design_draft' },
    });
    const s2 = streamReducer(s1, { type: 'state', data: snapshot1 });

    expect(s2.state?.issue_json).toEqual({ workflow: 'default', phase: 'design_draft' });
  });

  it('subsequent state event updates workflow/phase (simulating phase change)', () => {
    const s1 = makeState();

    // First state snapshot: design_draft phase
    const snapshot1 = makeStateSnapshot({
      issue_json: { workflow: 'default', phase: 'design_draft' },
    });
    const s2 = streamReducer(s1, { type: 'state', data: snapshot1 });
    expect(s2.state?.issue_json?.workflow).toBe('default');
    expect(s2.state?.issue_json?.phase).toBe('design_draft');

    // Second state snapshot: phase changed to implement_task
    const snapshot2 = makeStateSnapshot({
      issue_json: { workflow: 'default', phase: 'implement_task' },
    });
    const s3 = streamReducer(s2, { type: 'state', data: snapshot2 });

    // Assert workflow/phase updated via state event
    expect(s3.state?.issue_json?.workflow).toBe('default');
    expect(s3.state?.issue_json?.phase).toBe('implement_task');
  });

  it('subsequent state event updates workflow (simulating workflow change)', () => {
    const s1 = makeState();

    // First state snapshot: default workflow
    const snapshot1 = makeStateSnapshot({
      issue_json: { workflow: 'default', phase: 'design_review' },
    });
    const s2 = streamReducer(s1, { type: 'state', data: snapshot1 });
    expect(s2.state?.issue_json?.workflow).toBe('default');

    // Second state snapshot: workflow changed to custom-flow
    const snapshot2 = makeStateSnapshot({
      issue_json: { workflow: 'custom-flow', phase: 'task_decomposition' },
    });
    const s3 = streamReducer(s2, { type: 'state', data: snapshot2 });

    // Assert workflow updated via state event
    expect(s3.state?.issue_json?.workflow).toBe('custom-flow');
    expect(s3.state?.issue_json?.phase).toBe('task_decomposition');
  });

  it('state event with null issue_json clears workflow/phase', () => {
    const s1 = makeState();

    // First state snapshot with workflow/phase
    const snapshot1 = makeStateSnapshot({
      issue_json: { workflow: 'default', phase: 'design_draft' },
    });
    const s2 = streamReducer(s1, { type: 'state', data: snapshot1 });
    expect(s2.state?.issue_json?.workflow).toBe('default');

    // Second state snapshot with null issue_json
    const snapshot2 = makeStateSnapshot({
      issue_json: null,
    });
    const s3 = streamReducer(s2, { type: 'state', data: snapshot2 });

    // Assert issue_json is now null
    expect(s3.state?.issue_json).toBeNull();
  });
});

function makeSonarTokenStatusEvent(overrides: Partial<SonarTokenStatusEvent> = {}): SonarTokenStatusEvent {
  return {
    issue_ref: 'owner/repo#1',
    worktree_present: true,
    has_token: true,
    env_var_name: 'SONAR_TOKEN',
    sync_status: 'in_sync',
    last_attempt_at: '2026-02-04T10:00:00.000Z',
    last_success_at: '2026-02-04T10:00:00.000Z',
    last_error: null,
    ...overrides,
  };
}

describe('streamReducer sonar-token-status', () => {
  it('stores sonar-token-status event in state', () => {
    const s1 = makeState();
    const event = makeSonarTokenStatusEvent();
    const s2 = streamReducer(s1, { type: 'sonar-token-status', data: event });

    expect(s2.sonarTokenStatus).toEqual(event);
  });

  it('updates sonar-token-status when a new event arrives', () => {
    const s1 = makeState();
    const event1 = makeSonarTokenStatusEvent({ sync_status: 'in_sync' });
    const s2 = streamReducer(s1, { type: 'sonar-token-status', data: event1 });
    expect(s2.sonarTokenStatus?.sync_status).toBe('in_sync');

    const event2 = makeSonarTokenStatusEvent({
      sync_status: 'failed_env_write',
      last_error: 'Permission denied',
    });
    const s3 = streamReducer(s2, { type: 'sonar-token-status', data: event2 });

    expect(s3.sonarTokenStatus?.sync_status).toBe('failed_env_write');
    expect(s3.sonarTokenStatus?.last_error).toBe('Permission denied');
  });

  it('does NOT add sonar-token-status to sdkEvents', () => {
    const s1 = makeState();
    const event = makeSonarTokenStatusEvent();
    const s2 = streamReducer(s1, { type: 'sonar-token-status', data: event });

    // sdkEvents should remain empty - sonar-token-status is handled separately
    expect(s2.sdkEvents).toEqual([]);
  });

  it('preserves sonar-token-status across state snapshot updates', () => {
    const s1 = makeState();

    // First: sonar-token-status arrives
    const tokenEvent = makeSonarTokenStatusEvent({ issue_ref: 'owner/repo#1' });
    const s2 = streamReducer(s1, { type: 'sonar-token-status', data: tokenEvent });
    expect(s2.sonarTokenStatus).toEqual(tokenEvent);

    // Then: state snapshot arrives - sonarTokenStatus should be preserved
    const snapshot = makeStateSnapshot({ issue_ref: 'owner/repo#1' });
    const s3 = streamReducer(s2, { type: 'state', data: snapshot });

    // sonarTokenStatus is NOT cleared by state snapshots
    expect(s3.sonarTokenStatus).toEqual(tokenEvent);
  });

  it('preserves sonar-token-status across run updates', () => {
    const s1 = makeState();

    // First: sonar-token-status arrives
    const tokenEvent = makeSonarTokenStatusEvent();
    const s2 = streamReducer(s1, { type: 'sonar-token-status', data: tokenEvent });
    expect(s2.sonarTokenStatus).toEqual(tokenEvent);

    // Then: run update arrives - sonarTokenStatus should be preserved
    const runUpdate = makeRunStatus({ running: true, current_iteration: 3 });
    const s3 = streamReducer(s2, { type: 'run', data: { run: runUpdate } });

    expect(s3.sonarTokenStatus).toEqual(tokenEvent);
  });

  it('handles sonar-token-status for different issues', () => {
    const s1 = makeState();

    // Event for issue #1
    const event1 = makeSonarTokenStatusEvent({ issue_ref: 'owner/repo#1', has_token: true });
    const s2 = streamReducer(s1, { type: 'sonar-token-status', data: event1 });
    expect(s2.sonarTokenStatus?.issue_ref).toBe('owner/repo#1');
    expect(s2.sonarTokenStatus?.has_token).toBe(true);

    // Event for issue #2 replaces the stored status
    const event2 = makeSonarTokenStatusEvent({ issue_ref: 'owner/repo#2', has_token: false });
    const s3 = streamReducer(s2, { type: 'sonar-token-status', data: event2 });
    expect(s3.sonarTokenStatus?.issue_ref).toBe('owner/repo#2');
    expect(s3.sonarTokenStatus?.has_token).toBe(false);
  });
});

function makeAzureDevopsStatusEvent(
  overrides: Partial<AzureDevopsStatusEvent> = {}
): AzureDevopsStatusEvent {
  return {
    issue_ref: 'owner/repo#1',
    worktree_present: true,
    configured: true,
    organization: 'https://dev.azure.com/myorg',
    project: 'MyProject',
    has_pat: true,
    pat_last_updated_at: '2026-02-04T10:00:00.000Z',
    pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT',
    sync_status: 'in_sync',
    last_attempt_at: '2026-02-04T10:00:00.000Z',
    last_success_at: '2026-02-04T10:00:00.000Z',
    last_error: null,
    operation: 'put',
    ...overrides,
  };
}

describe('streamReducer azure-devops-status', () => {
  it('stores azure-devops-status event in state', () => {
    const s1 = makeState();
    const event = makeAzureDevopsStatusEvent();
    const s2 = streamReducer(s1, { type: 'azure-devops-status', data: event });

    expect(s2.azureDevopsStatus).toEqual(event);
  });

  it('updates azure-devops-status when a new event arrives', () => {
    const s1 = makeState();
    const event1 = makeAzureDevopsStatusEvent({ sync_status: 'in_sync' });
    const s2 = streamReducer(s1, { type: 'azure-devops-status', data: event1 });
    expect(s2.azureDevopsStatus?.sync_status).toBe('in_sync');

    const event2 = makeAzureDevopsStatusEvent({
      sync_status: 'failed_env_write',
      last_error: 'Permission denied',
      operation: 'reconcile',
    });
    const s3 = streamReducer(s2, { type: 'azure-devops-status', data: event2 });

    expect(s3.azureDevopsStatus?.sync_status).toBe('failed_env_write');
    expect(s3.azureDevopsStatus?.last_error).toBe('Permission denied');
    expect(s3.azureDevopsStatus?.operation).toBe('reconcile');
  });

  it('does NOT add azure-devops-status to sdkEvents', () => {
    const s1 = makeState();
    const event = makeAzureDevopsStatusEvent();
    const s2 = streamReducer(s1, { type: 'azure-devops-status', data: event });

    // sdkEvents should remain empty - azure-devops-status is handled separately
    expect(s2.sdkEvents).toEqual([]);
  });

  it('preserves azure-devops-status across state snapshot updates', () => {
    const s1 = makeState();

    // First: azure-devops-status arrives
    const azureEvent = makeAzureDevopsStatusEvent({ issue_ref: 'owner/repo#1' });
    const s2 = streamReducer(s1, { type: 'azure-devops-status', data: azureEvent });
    expect(s2.azureDevopsStatus).toEqual(azureEvent);

    // Then: state snapshot arrives - azureDevopsStatus should be preserved
    const snapshot = makeStateSnapshot({ issue_ref: 'owner/repo#1' });
    const s3 = streamReducer(s2, { type: 'state', data: snapshot });

    // azureDevopsStatus is NOT cleared by state snapshots
    expect(s3.azureDevopsStatus).toEqual(azureEvent);
  });

  it('preserves azure-devops-status across run updates', () => {
    const s1 = makeState();

    // First: azure-devops-status arrives
    const azureEvent = makeAzureDevopsStatusEvent();
    const s2 = streamReducer(s1, { type: 'azure-devops-status', data: azureEvent });
    expect(s2.azureDevopsStatus).toEqual(azureEvent);

    // Then: run update arrives - azureDevopsStatus should be preserved
    const runUpdate = makeRunStatus({ running: true, current_iteration: 3 });
    const s3 = streamReducer(s2, { type: 'run', data: { run: runUpdate } });

    expect(s3.azureDevopsStatus).toEqual(azureEvent);
  });

  it('handles azure-devops-status for different issues', () => {
    const s1 = makeState();

    // Event for issue #1
    const event1 = makeAzureDevopsStatusEvent({ issue_ref: 'owner/repo#1', has_pat: true });
    const s2 = streamReducer(s1, { type: 'azure-devops-status', data: event1 });
    expect(s2.azureDevopsStatus?.issue_ref).toBe('owner/repo#1');
    expect(s2.azureDevopsStatus?.has_pat).toBe(true);

    // Event for issue #2 replaces the stored status
    const event2 = makeAzureDevopsStatusEvent({ issue_ref: 'owner/repo#2', has_pat: false });
    const s3 = streamReducer(s2, { type: 'azure-devops-status', data: event2 });
    expect(s3.azureDevopsStatus?.issue_ref).toBe('owner/repo#2');
    expect(s3.azureDevopsStatus?.has_pat).toBe(false);
  });

  it('does not interfere with sonar-token-status', () => {
    const s1 = makeState();

    const sonarEvent = makeSonarTokenStatusEvent();
    const azureEvent = makeAzureDevopsStatusEvent();

    const s2 = streamReducer(s1, { type: 'sonar-token-status', data: sonarEvent });
    const s3 = streamReducer(s2, { type: 'azure-devops-status', data: azureEvent });

    // Both should be stored independently
    expect(s3.sonarTokenStatus).toEqual(sonarEvent);
    expect(s3.azureDevopsStatus).toEqual(azureEvent);
  });
});

function makeIssueIngestStatusEvent(
  overrides: Partial<IssueIngestStatusEvent> = {}
): IssueIngestStatusEvent {
  return {
    issue_ref: 'owner/repo#1',
    provider: 'github',
    mode: 'create',
    outcome: 'success',
    remote_id: '42',
    remote_url: 'https://github.com/owner/repo/issues/42',
    warnings: [],
    auto_select: { requested: false, ok: false },
    auto_run: { requested: false, ok: false },
    occurred_at: '2026-02-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('streamReducer issue-ingest-status', () => {
  it('stores issue-ingest-status event in state', () => {
    const s1 = makeState();
    const event = makeIssueIngestStatusEvent();
    const s2 = streamReducer(s1, { type: 'issue-ingest-status', data: event });

    expect(s2.issueIngestStatus).toEqual(event);
  });

  it('updates issue-ingest-status when a new event arrives', () => {
    const s1 = makeState();
    const event1 = makeIssueIngestStatusEvent({ outcome: 'success' });
    const s2 = streamReducer(s1, { type: 'issue-ingest-status', data: event1 });
    expect(s2.issueIngestStatus?.outcome).toBe('success');

    const event2 = makeIssueIngestStatusEvent({
      outcome: 'partial',
      warnings: ['Init failed'],
    });
    const s3 = streamReducer(s2, { type: 'issue-ingest-status', data: event2 });

    expect(s3.issueIngestStatus?.outcome).toBe('partial');
    expect(s3.issueIngestStatus?.warnings).toEqual(['Init failed']);
  });

  it('does NOT add issue-ingest-status to sdkEvents', () => {
    const s1 = makeState();
    const event = makeIssueIngestStatusEvent();
    const s2 = streamReducer(s1, { type: 'issue-ingest-status', data: event });

    // sdkEvents should remain empty - issue-ingest-status is handled separately
    expect(s2.sdkEvents).toEqual([]);
  });

  it('preserves issue-ingest-status across state snapshot updates', () => {
    const s1 = makeState();

    // First: issue-ingest-status arrives
    const ingestEvent = makeIssueIngestStatusEvent({ issue_ref: 'owner/repo#1' });
    const s2 = streamReducer(s1, { type: 'issue-ingest-status', data: ingestEvent });
    expect(s2.issueIngestStatus).toEqual(ingestEvent);

    // Then: state snapshot arrives - issueIngestStatus should be preserved
    const snapshot = makeStateSnapshot({ issue_ref: 'owner/repo#1' });
    const s3 = streamReducer(s2, { type: 'state', data: snapshot });

    // issueIngestStatus is NOT cleared by state snapshots
    expect(s3.issueIngestStatus).toEqual(ingestEvent);
  });

  it('preserves issue-ingest-status across run updates', () => {
    const s1 = makeState();

    // First: issue-ingest-status arrives
    const ingestEvent = makeIssueIngestStatusEvent();
    const s2 = streamReducer(s1, { type: 'issue-ingest-status', data: ingestEvent });
    expect(s2.issueIngestStatus).toEqual(ingestEvent);

    // Then: run update arrives - issueIngestStatus should be preserved
    const runUpdate = makeRunStatus({ running: true, current_iteration: 3 });
    const s3 = streamReducer(s2, { type: 'run', data: { run: runUpdate } });

    expect(s3.issueIngestStatus).toEqual(ingestEvent);
  });

  it('stores error outcome with error details', () => {
    const s1 = makeState();
    const event = makeIssueIngestStatusEvent({
      outcome: 'error',
      error: { code: 'auth', message: 'Authentication failed' },
    });
    const s2 = streamReducer(s1, { type: 'issue-ingest-status', data: event });

    expect(s2.issueIngestStatus?.outcome).toBe('error');
    expect(s2.issueIngestStatus?.error?.code).toBe('auth');
    expect(s2.issueIngestStatus?.error?.message).toBe('Authentication failed');
  });

  it('handles azure_devops provider events', () => {
    const s1 = makeState();
    const event = makeIssueIngestStatusEvent({
      provider: 'azure_devops',
      mode: 'init_existing',
      outcome: 'success',
      remote_id: '123',
      remote_url: 'https://dev.azure.com/org/project/_workitems/edit/123',
    });
    const s2 = streamReducer(s1, { type: 'issue-ingest-status', data: event });

    expect(s2.issueIngestStatus?.provider).toBe('azure_devops');
    expect(s2.issueIngestStatus?.mode).toBe('init_existing');
    expect(s2.issueIngestStatus?.remote_url).toBe(
      'https://dev.azure.com/org/project/_workitems/edit/123'
    );
  });

  it('does not interfere with other status events', () => {
    const s1 = makeState();

    const sonarEvent = makeSonarTokenStatusEvent();
    const azureEvent = makeAzureDevopsStatusEvent();
    const ingestEvent = makeIssueIngestStatusEvent();

    let state = streamReducer(s1, { type: 'sonar-token-status', data: sonarEvent });
    state = streamReducer(state, { type: 'azure-devops-status', data: azureEvent });
    state = streamReducer(state, { type: 'issue-ingest-status', data: ingestEvent });

    // All three should be stored independently
    expect(state.sonarTokenStatus).toEqual(sonarEvent);
    expect(state.azureDevopsStatus).toEqual(azureEvent);
    expect(state.issueIngestStatus).toEqual(ingestEvent);
  });
});

function makeProjectFilesStatusEvent(
  overrides: Partial<ProjectFilesStatusEvent> = {},
): ProjectFilesStatusEvent {
  return {
    issue_ref: 'owner/repo#1',
    worktree_present: true,
    file_count: 1,
    files: [{
      id: 'abc',
      display_name: 'connections.local.config',
      target_path: 'connections.local.config',
      size_bytes: 123,
      sha256: 'deadbeef',
      updated_at: '2026-02-07T12:00:00.000Z',
    }],
    sync_status: 'in_sync',
    last_attempt_at: '2026-02-07T12:00:00.000Z',
    last_success_at: '2026-02-07T12:00:00.000Z',
    last_error: null,
    operation: 'put',
    ...overrides,
  };
}

describe('streamReducer project-files-status', () => {
  it('stores project-files-status event in state', () => {
    const s1 = makeState();
    const event = makeProjectFilesStatusEvent();
    const s2 = streamReducer(s1, { type: 'project-files-status', data: event });
    expect(s2.projectFilesStatus).toEqual(event);
  });

  it('does not interfere with other status events', () => {
    const s1 = makeState();
    const sonarEvent = makeSonarTokenStatusEvent();
    const azureEvent = makeAzureDevopsStatusEvent();
    const projectEvent = makeProjectFilesStatusEvent();

    let state = streamReducer(s1, { type: 'sonar-token-status', data: sonarEvent });
    state = streamReducer(state, { type: 'azure-devops-status', data: azureEvent });
    state = streamReducer(state, { type: 'project-files-status', data: projectEvent });

    expect(state.sonarTokenStatus).toEqual(sonarEvent);
    expect(state.azureDevopsStatus).toEqual(azureEvent);
    expect(state.projectFilesStatus).toEqual(projectEvent);
  });
});
