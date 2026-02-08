/**
 * Tests for Azure DevOps state helpers.
 */

import { describe, it, expect } from 'vitest';

import type { AzureDevopsStatusResponse, AzureDevopsStatusEvent } from '../../api/azureDevopsTypes.js';
import { mergeAzureDevopsStatus, queryStatusToStatus, eventStatusToStatus, isEventForCurrentIssue } from './state.js';

describe('mergeAzureDevopsStatus', () => {
  const baseQueryStatus: AzureDevopsStatusResponse = {
    ok: true,
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
  };

  const baseEventStatus: AzureDevopsStatusEvent = {
    issue_ref: 'owner/repo#1',
    worktree_present: true,
    configured: true,
    organization: 'https://dev.azure.com/myorg',
    project: 'MyProject',
    has_pat: true,
    pat_last_updated_at: '2026-02-04T11:00:00.000Z',
    pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT',
    sync_status: 'in_sync',
    last_attempt_at: '2026-02-04T11:00:00.000Z',
    last_success_at: '2026-02-04T11:00:00.000Z',
    last_error: null,
    operation: 'put',
  };

  it('returns null when no issue is selected', () => {
    const result = mergeAzureDevopsStatus(baseQueryStatus, baseEventStatus, null);
    expect(result).toBeNull();
  });

  it('returns null when no query data and no matching event', () => {
    const result = mergeAzureDevopsStatus(undefined, null, 'owner/repo#1');
    expect(result).toBeNull();
  });

  it('returns event data when no query data but event matches current issue', () => {
    const result = mergeAzureDevopsStatus(undefined, baseEventStatus, 'owner/repo#1');
    expect(result).toEqual(eventStatusToStatus(baseEventStatus));
  });

  it('returns query data when no event', () => {
    const result = mergeAzureDevopsStatus(baseQueryStatus, null, 'owner/repo#1');
    expect(result).toEqual(queryStatusToStatus(baseQueryStatus));
  });

  it('returns query data when event is for a different issue', () => {
    const differentIssueEvent: AzureDevopsStatusEvent = {
      ...baseEventStatus,
      issue_ref: 'owner/repo#2',
    };
    const result = mergeAzureDevopsStatus(baseQueryStatus, differentIssueEvent, 'owner/repo#1');
    expect(result).toEqual(queryStatusToStatus(baseQueryStatus));
  });

  it('returns event data when it has a more recent timestamp', () => {
    const result = mergeAzureDevopsStatus(baseQueryStatus, baseEventStatus, 'owner/repo#1');
    // Event is at 11:00, query is at 10:00 - event wins
    expect(result).toEqual(eventStatusToStatus(baseEventStatus));
  });

  it('returns query data when it has a more recent timestamp', () => {
    const olderEvent: AzureDevopsStatusEvent = {
      ...baseEventStatus,
      last_attempt_at: '2026-02-04T09:00:00.000Z',
    };
    const result = mergeAzureDevopsStatus(baseQueryStatus, olderEvent, 'owner/repo#1');
    // Query is at 10:00, event is at 09:00 - query wins
    expect(result).toEqual(queryStatusToStatus(baseQueryStatus));
  });

  it('returns event data when query has no timestamp', () => {
    const queryWithNoTimestamp: AzureDevopsStatusResponse = {
      ...baseQueryStatus,
      last_attempt_at: null,
    };
    const result = mergeAzureDevopsStatus(queryWithNoTimestamp, baseEventStatus, 'owner/repo#1');
    expect(result).toEqual(eventStatusToStatus(baseEventStatus));
  });

  it('returns event data when timestamps are equal', () => {
    const sameTimestamp = '2026-02-04T10:00:00.000Z';
    const queryWithSameTimestamp: AzureDevopsStatusResponse = {
      ...baseQueryStatus,
      last_attempt_at: sameTimestamp,
    };
    const eventWithSameTimestamp: AzureDevopsStatusEvent = {
      ...baseEventStatus,
      last_attempt_at: sameTimestamp,
    };
    const result = mergeAzureDevopsStatus(queryWithSameTimestamp, eventWithSameTimestamp, 'owner/repo#1');
    // When equal, event wins (>= comparison)
    expect(result).toEqual(eventStatusToStatus(eventWithSameTimestamp));
  });

  it('preserves all status fields from event when event wins', () => {
    const detailedEvent: AzureDevopsStatusEvent = {
      issue_ref: 'owner/repo#1',
      worktree_present: false,
      configured: false,
      organization: null,
      project: null,
      has_pat: false,
      pat_last_updated_at: null,
      pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT',
      sync_status: 'failed_env_write',
      last_attempt_at: '2026-02-04T12:00:00.000Z',
      last_success_at: '2026-02-04T08:00:00.000Z',
      last_error: 'Permission denied',
      operation: 'reconcile',
    };
    const result = mergeAzureDevopsStatus(baseQueryStatus, detailedEvent, 'owner/repo#1');
    expect(result).toEqual(eventStatusToStatus(detailedEvent));
    expect(result?.worktree_present).toBe(false);
    expect(result?.configured).toBe(false);
    expect(result?.has_pat).toBe(false);
    expect(result?.organization).toBeNull();
    expect(result?.sync_status).toBe('failed_env_write');
    expect(result?.last_error).toBe('Permission denied');
  });
});

describe('queryStatusToStatus', () => {
  it('strips the ok field from response', () => {
    const response: AzureDevopsStatusResponse = {
      ok: true,
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
    };

    const result = queryStatusToStatus(response);

    expect(result).toEqual({
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
    });
    expect(result).not.toHaveProperty('ok');
  });
});

describe('eventStatusToStatus', () => {
  it('strips the operation field from event', () => {
    const event: AzureDevopsStatusEvent = {
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
    };

    const result = eventStatusToStatus(event);
    expect(result).not.toHaveProperty('operation');
    expect(result.issue_ref).toBe('owner/repo#1');
    expect(result.configured).toBe(true);
  });
});

describe('isEventForCurrentIssue', () => {
  const event: AzureDevopsStatusEvent = {
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
