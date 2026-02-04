/**
 * Tests for Sonar token state helpers.
 */

import { describe, it, expect } from 'vitest';

import type { SonarTokenStatusResponse, SonarTokenStatusEvent } from '../../api/sonarTokenTypes.js';
import { mergeSonarTokenStatus, queryStatusToStatus, isEventForCurrentIssue } from './state.js';

describe('mergeSonarTokenStatus', () => {
  const baseQueryStatus: SonarTokenStatusResponse = {
    ok: true,
    issue_ref: 'owner/repo#1',
    worktree_present: true,
    has_token: true,
    env_var_name: 'SONAR_TOKEN',
    sync_status: 'in_sync',
    last_attempt_at: '2026-02-04T10:00:00.000Z',
    last_success_at: '2026-02-04T10:00:00.000Z',
    last_error: null,
  };

  const baseEventStatus: SonarTokenStatusEvent = {
    issue_ref: 'owner/repo#1',
    worktree_present: true,
    has_token: true,
    env_var_name: 'SONAR_TOKEN',
    sync_status: 'in_sync',
    last_attempt_at: '2026-02-04T11:00:00.000Z',
    last_success_at: '2026-02-04T11:00:00.000Z',
    last_error: null,
  };

  it('returns null when no issue is selected', () => {
    const result = mergeSonarTokenStatus(baseQueryStatus, baseEventStatus, null);
    expect(result).toBeNull();
  });

  it('returns null when no query data and no matching event', () => {
    const result = mergeSonarTokenStatus(undefined, null, 'owner/repo#1');
    expect(result).toBeNull();
  });

  it('returns event when no query data but event matches current issue', () => {
    const result = mergeSonarTokenStatus(undefined, baseEventStatus, 'owner/repo#1');
    expect(result).toEqual(baseEventStatus);
  });

  it('returns query data when no event', () => {
    const result = mergeSonarTokenStatus(baseQueryStatus, null, 'owner/repo#1');
    expect(result).toEqual(queryStatusToStatus(baseQueryStatus));
  });

  it('returns query data when event is for a different issue', () => {
    const differentIssueEvent: SonarTokenStatusEvent = {
      ...baseEventStatus,
      issue_ref: 'owner/repo#2',
    };
    const result = mergeSonarTokenStatus(baseQueryStatus, differentIssueEvent, 'owner/repo#1');
    expect(result).toEqual(queryStatusToStatus(baseQueryStatus));
  });

  it('returns event when it has a more recent timestamp', () => {
    const result = mergeSonarTokenStatus(baseQueryStatus, baseEventStatus, 'owner/repo#1');
    // Event is at 11:00, query is at 10:00 - event wins
    expect(result).toEqual(baseEventStatus);
  });

  it('returns query data when it has a more recent timestamp', () => {
    const olderEvent: SonarTokenStatusEvent = {
      ...baseEventStatus,
      last_attempt_at: '2026-02-04T09:00:00.000Z',
    };
    const result = mergeSonarTokenStatus(baseQueryStatus, olderEvent, 'owner/repo#1');
    // Query is at 10:00, event is at 09:00 - query wins
    expect(result).toEqual(queryStatusToStatus(baseQueryStatus));
  });

  it('returns event when query has no timestamp', () => {
    const queryWithNoTimestamp: SonarTokenStatusResponse = {
      ...baseQueryStatus,
      last_attempt_at: null,
    };
    const result = mergeSonarTokenStatus(queryWithNoTimestamp, baseEventStatus, 'owner/repo#1');
    expect(result).toEqual(baseEventStatus);
  });

  it('returns event when timestamps are equal', () => {
    const sameTimestamp = '2026-02-04T10:00:00.000Z';
    const queryWithSameTimestamp: SonarTokenStatusResponse = {
      ...baseQueryStatus,
      last_attempt_at: sameTimestamp,
    };
    const eventWithSameTimestamp: SonarTokenStatusEvent = {
      ...baseEventStatus,
      last_attempt_at: sameTimestamp,
    };
    const result = mergeSonarTokenStatus(queryWithSameTimestamp, eventWithSameTimestamp, 'owner/repo#1');
    // When equal, event wins (>= comparison)
    expect(result).toEqual(eventWithSameTimestamp);
  });

  it('preserves all status fields from event when event wins', () => {
    const detailedEvent: SonarTokenStatusEvent = {
      issue_ref: 'owner/repo#1',
      worktree_present: false,
      has_token: false,
      env_var_name: 'CUSTOM_TOKEN',
      sync_status: 'failed_env_write',
      last_attempt_at: '2026-02-04T12:00:00.000Z',
      last_success_at: '2026-02-04T08:00:00.000Z',
      last_error: 'Permission denied',
    };
    const result = mergeSonarTokenStatus(baseQueryStatus, detailedEvent, 'owner/repo#1');
    expect(result).toEqual(detailedEvent);
    expect(result?.worktree_present).toBe(false);
    expect(result?.has_token).toBe(false);
    expect(result?.env_var_name).toBe('CUSTOM_TOKEN');
    expect(result?.sync_status).toBe('failed_env_write');
    expect(result?.last_error).toBe('Permission denied');
  });
});

describe('queryStatusToStatus', () => {
  it('strips the ok field from response', () => {
    const response: SonarTokenStatusResponse = {
      ok: true,
      issue_ref: 'owner/repo#1',
      worktree_present: true,
      has_token: true,
      env_var_name: 'SONAR_TOKEN',
      sync_status: 'in_sync',
      last_attempt_at: '2026-02-04T10:00:00.000Z',
      last_success_at: '2026-02-04T10:00:00.000Z',
      last_error: null,
    };

    const result = queryStatusToStatus(response);

    expect(result).toEqual({
      issue_ref: 'owner/repo#1',
      worktree_present: true,
      has_token: true,
      env_var_name: 'SONAR_TOKEN',
      sync_status: 'in_sync',
      last_attempt_at: '2026-02-04T10:00:00.000Z',
      last_success_at: '2026-02-04T10:00:00.000Z',
      last_error: null,
    });
    expect(result).not.toHaveProperty('ok');
  });
});

describe('isEventForCurrentIssue', () => {
  const event: SonarTokenStatusEvent = {
    issue_ref: 'owner/repo#1',
    worktree_present: true,
    has_token: true,
    env_var_name: 'SONAR_TOKEN',
    sync_status: 'in_sync',
    last_attempt_at: '2026-02-04T10:00:00.000Z',
    last_success_at: '2026-02-04T10:00:00.000Z',
    last_error: null,
  };

  it('returns false when event is null', () => {
    expect(isEventForCurrentIssue(null, 'owner/repo#1')).toBe(false);
  });

  it('returns false when currentIssueRef is null', () => {
    expect(isEventForCurrentIssue(event, null)).toBe(false);
  });

  it('returns false when event is for a different issue', () => {
    expect(isEventForCurrentIssue(event, 'owner/repo#2')).toBe(false);
  });

  it('returns true when event matches current issue', () => {
    expect(isEventForCurrentIssue(event, 'owner/repo#1')).toBe(true);
  });
});
