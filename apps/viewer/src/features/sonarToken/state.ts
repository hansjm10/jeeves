/**
 * State helpers for Sonar token management.
 *
 * These pure functions help merge stream events with query-fetched status,
 * ensuring the UI stays fresh when `sonar-token-status` events arrive.
 *
 * NOTE: Automatic query invalidation on stream events is now handled by
 * `SonarTokenStreamSyncInternal` in ViewerStreamProvider.tsx. The helper
 * functions here are still useful for components that want to access or
 * merge the stream status directly.
 */

import type { SonarTokenStatus, SonarTokenStatusEvent, SonarTokenStatusResponse } from '../../api/sonarTokenTypes.js';

/**
 * Merge a streamed `sonar-token-status` event with query-fetched status data.
 *
 * The event takes precedence when:
 * 1. It matches the current issue (by issue_ref)
 * 2. It has a more recent `last_attempt_at` timestamp (or the query has none)
 *
 * @param queryStatus - The status from the React Query cache (may be undefined if not yet fetched)
 * @param eventStatus - The latest `sonar-token-status` event from the stream (may be null if none received)
 * @param currentIssueRef - The currently selected issue ref (may be null if none selected)
 * @returns The merged status to display, or null if no data is available
 */
export function mergeSonarTokenStatus(
  queryStatus: SonarTokenStatusResponse | undefined,
  eventStatus: SonarTokenStatusEvent | null,
  currentIssueRef: string | null
): SonarTokenStatus | null {
  // No issue selected - nothing to show
  if (!currentIssueRef) {
    return null;
  }

  // If we have no query data, check if the event matches the current issue
  if (!queryStatus) {
    if (eventStatus && eventStatus.issue_ref === currentIssueRef) {
      return eventStatus;
    }
    return null;
  }

  // If no event or event is for a different issue, use query data
  if (!eventStatus || eventStatus.issue_ref !== currentIssueRef) {
    return queryStatusToStatus(queryStatus);
  }

  // Both query and event exist for the current issue - use the fresher one
  // Compare by last_attempt_at timestamp (more recent wins)
  const queryAttemptAt = queryStatus.last_attempt_at;
  const eventAttemptAt = eventStatus.last_attempt_at;

  // Event wins if query has no timestamp, or event is more recent
  if (!queryAttemptAt) {
    return eventStatus;
  }
  if (eventAttemptAt && new Date(eventAttemptAt) >= new Date(queryAttemptAt)) {
    return eventStatus;
  }

  // Query data is fresher
  return queryStatusToStatus(queryStatus);
}

/**
 * Convert a `SonarTokenStatusResponse` (with `ok: true`) to a `SonarTokenStatus` (without `ok`).
 */
export function queryStatusToStatus(response: SonarTokenStatusResponse): SonarTokenStatus {
  return {
    issue_ref: response.issue_ref,
    worktree_present: response.worktree_present,
    has_token: response.has_token,
    env_var_name: response.env_var_name,
    sync_status: response.sync_status,
    last_attempt_at: response.last_attempt_at,
    last_success_at: response.last_success_at,
    last_error: response.last_error,
  };
}

/**
 * Check if a `sonar-token-status` event matches the current issue.
 *
 * @param event - The event to check (may be null)
 * @param currentIssueRef - The currently selected issue ref (may be null)
 * @returns True if the event matches the current issue
 */
export function isEventForCurrentIssue(
  event: SonarTokenStatusEvent | null,
  currentIssueRef: string | null
): boolean {
  if (!event || !currentIssueRef) {
    return false;
  }
  return event.issue_ref === currentIssueRef;
}

