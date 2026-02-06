/**
 * State helpers for Azure DevOps credential management.
 *
 * These pure functions help merge stream events with query-fetched status,
 * ensuring the UI stays fresh when `azure-devops-status` events arrive.
 */

import type { AzureDevopsStatus, AzureDevopsStatusEvent, AzureDevopsStatusResponse } from '../../api/azureDevopsTypes.js';

/**
 * Merge a streamed `azure-devops-status` event with query-fetched status data.
 *
 * The event takes precedence when:
 * 1. It matches the current issue (by issue_ref)
 * 2. It has a more recent `last_attempt_at` timestamp (or the query has none)
 *
 * @param queryStatus - The status from the React Query cache (may be undefined if not yet fetched)
 * @param eventStatus - The latest `azure-devops-status` event from the stream (may be null if none received)
 * @param currentIssueRef - The currently selected issue ref (may be null if none selected)
 * @returns The merged status to display, or null if no data is available
 */
export function mergeAzureDevopsStatus(
  queryStatus: AzureDevopsStatusResponse | undefined,
  eventStatus: AzureDevopsStatusEvent | null,
  currentIssueRef: string | null
): AzureDevopsStatus | null {
  // No issue selected - nothing to show
  if (!currentIssueRef) {
    return null;
  }

  // If we have no query data, check if the event matches the current issue
  if (!queryStatus) {
    if (eventStatus && eventStatus.issue_ref === currentIssueRef) {
      return eventStatusToStatus(eventStatus);
    }
    return null;
  }

  // If no event or event is for a different issue, use query data
  if (!eventStatus || eventStatus.issue_ref !== currentIssueRef) {
    return queryStatusToStatus(queryStatus);
  }

  // Both query and event exist for the current issue - use the fresher one
  const queryAttemptAt = queryStatus.last_attempt_at;
  const eventAttemptAt = eventStatus.last_attempt_at;

  // Event wins if query has no timestamp, or event is more recent
  if (!queryAttemptAt) {
    return eventStatusToStatus(eventStatus);
  }
  if (eventAttemptAt && new Date(eventAttemptAt) >= new Date(queryAttemptAt)) {
    return eventStatusToStatus(eventStatus);
  }

  // Query data is fresher
  return queryStatusToStatus(queryStatus);
}

/**
 * Convert an `AzureDevopsStatusResponse` (with `ok: true`) to an `AzureDevopsStatus` (without `ok`).
 */
export function queryStatusToStatus(response: AzureDevopsStatusResponse): AzureDevopsStatus {
  return {
    issue_ref: response.issue_ref,
    worktree_present: response.worktree_present,
    configured: response.configured,
    organization: response.organization,
    project: response.project,
    has_pat: response.has_pat,
    pat_last_updated_at: response.pat_last_updated_at,
    pat_env_var_name: response.pat_env_var_name,
    sync_status: response.sync_status,
    last_attempt_at: response.last_attempt_at,
    last_success_at: response.last_success_at,
    last_error: response.last_error,
  };
}

/**
 * Convert an `AzureDevopsStatusEvent` (with `operation`) to an `AzureDevopsStatus` (without `operation`).
 */
export function eventStatusToStatus(event: AzureDevopsStatusEvent): AzureDevopsStatus {
  return {
    issue_ref: event.issue_ref,
    worktree_present: event.worktree_present,
    configured: event.configured,
    organization: event.organization,
    project: event.project,
    has_pat: event.has_pat,
    pat_last_updated_at: event.pat_last_updated_at,
    pat_env_var_name: event.pat_env_var_name,
    sync_status: event.sync_status,
    last_attempt_at: event.last_attempt_at,
    last_success_at: event.last_success_at,
    last_error: event.last_error,
  };
}

/**
 * Check if an `azure-devops-status` event matches the current issue.
 */
export function isEventForCurrentIssue(
  event: AzureDevopsStatusEvent | null,
  currentIssueRef: string | null
): boolean {
  if (!event || !currentIssueRef) {
    return false;
  }
  return event.issue_ref === currentIssueRef;
}
