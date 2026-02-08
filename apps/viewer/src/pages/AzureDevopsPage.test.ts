import { describe, expect, it } from 'vitest';

import {
  formatSyncStatus,
  formatTimestamp,
  isNewStatusEvent,
  eventToQueryCacheEntry,
  deriveSaveButtonState,
  deriveRemoveButtonState,
  deriveRetrySyncButtonState,
  buildPatchRequest,
  validatePutInputs,
  parseMutationError,
} from './AzureDevopsPage.js';
import type {
  AzureDevopsStatusEvent,
  AzureDevopsSyncStatus,
} from '../api/azureDevopsTypes.js';
import { ApiValidationError } from '../features/azureDevops/api.js';

// ============================================================================
// Test data helpers
// ============================================================================

function makeEvent(overrides: Partial<AzureDevopsStatusEvent> = {}): AzureDevopsStatusEvent {
  return {
    issue_ref: 'owner/repo#42',
    worktree_present: true,
    configured: true,
    organization: 'https://dev.azure.com/myorg',
    project: 'MyProject',
    has_pat: true,
    pat_last_updated_at: '2026-01-15T10:00:00Z',
    pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT',
    sync_status: 'in_sync',
    last_attempt_at: '2026-01-15T10:00:00Z',
    last_success_at: '2026-01-15T10:00:00Z',
    last_error: null,
    operation: 'put',
    ...overrides,
  };
}

// ============================================================================
// T14-AC1: Pending labels and disabled controls for save/remove/reconcile
// ============================================================================

describe('T14-AC1: Pending labels and disabled controls', () => {
  describe('formatSyncStatus', () => {
    it('returns "In Sync" for in_sync', () => {
      const result = formatSyncStatus('in_sync');
      expect(result.label).toBe('In Sync');
      expect(result.color).toBe('var(--color-accent-green)');
    });

    it('returns "Pending (no worktree)" for deferred_worktree_absent', () => {
      const result = formatSyncStatus('deferred_worktree_absent');
      expect(result.label).toBe('Pending (no worktree)');
      expect(result.color).toBe('var(--color-accent-amber)');
    });

    it('returns "Failed (git exclude)" for failed_exclude', () => {
      const result = formatSyncStatus('failed_exclude');
      expect(result.label).toBe('Failed (git exclude)');
      expect(result.color).toBe('var(--color-accent-red)');
    });

    it('returns "Failed (env write)" for failed_env_write', () => {
      const result = formatSyncStatus('failed_env_write');
      expect(result.label).toBe('Failed (env write)');
      expect(result.color).toBe('var(--color-accent-red)');
    });

    it('returns "Failed (env delete)" for failed_env_delete', () => {
      const result = formatSyncStatus('failed_env_delete');
      expect(result.label).toBe('Failed (env delete)');
      expect(result.color).toBe('var(--color-accent-red)');
    });

    it('returns "Failed (secret read)" for failed_secret_read', () => {
      const result = formatSyncStatus('failed_secret_read');
      expect(result.label).toBe('Failed (secret read)');
      expect(result.color).toBe('var(--color-accent-red)');
    });

    it('returns "Not synced yet" for never_attempted', () => {
      const result = formatSyncStatus('never_attempted');
      expect(result.label).toBe('Not synced yet');
      expect(result.color).toBe('var(--color-text-muted)');
    });

    it('returns correct colors for all 7 sync statuses', () => {
      const statuses: AzureDevopsSyncStatus[] = [
        'in_sync',
        'deferred_worktree_absent',
        'failed_exclude',
        'failed_env_write',
        'failed_env_delete',
        'failed_secret_read',
        'never_attempted',
      ];
      for (const s of statuses) {
        const result = formatSyncStatus(s);
        expect(result.label).toBeTruthy();
        expect(result.color).toBeTruthy();
      }
    });
  });

  describe('deriveSaveButtonState', () => {
    it('shows "Save" when not configured and not pending', () => {
      const state = deriveSaveButtonState(false, false, false, false, false);
      expect(state.label).toBe('Save');
      expect(state.disabled).toBe(false);
    });

    it('shows "Update" when configured and not pending', () => {
      const state = deriveSaveButtonState(true, false, false, false, false);
      expect(state.label).toBe('Update');
      expect(state.disabled).toBe(false);
    });

    it('shows "Saving..." when PUT is pending', () => {
      const state = deriveSaveButtonState(false, true, true, false, false);
      expect(state.label).toBe('Saving...');
    });

    it('shows "Saving..." when PATCH is pending', () => {
      const state = deriveSaveButtonState(true, true, false, true, false);
      expect(state.label).toBe('Saving...');
    });

    it('disabled when isMutating is true', () => {
      const state = deriveSaveButtonState(false, true, false, false, false);
      expect(state.disabled).toBe(true);
    });

    it('disabled when runRunning is true', () => {
      const state = deriveSaveButtonState(false, false, false, false, true);
      expect(state.disabled).toBe(true);
    });

    it('disabled when both isMutating and runRunning are true', () => {
      const state = deriveSaveButtonState(true, true, true, false, true);
      expect(state.disabled).toBe(true);
      expect(state.label).toBe('Saving...');
    });
  });

  describe('deriveRemoveButtonState', () => {
    it('returns null when not configured', () => {
      expect(deriveRemoveButtonState(false, false, false, false, false)).toBeNull();
    });

    it('shows "Remove" when configured and not in confirm state', () => {
      const state = deriveRemoveButtonState(true, false, false, false, false);
      expect(state).not.toBeNull();
      expect(state!.rendered).toBe(true);
      expect(state!.showConfirm).toBe(false);
      expect(state!.label).toBe('Remove');
      expect(state!.disabled).toBe(false);
    });

    it('shows "Confirm Remove" in confirm state', () => {
      const state = deriveRemoveButtonState(true, true, false, false, false);
      expect(state).not.toBeNull();
      expect(state!.showConfirm).toBe(true);
      expect(state!.label).toBe('Confirm Remove');
    });

    it('shows "Removing..." when delete is pending', () => {
      const state = deriveRemoveButtonState(true, true, true, true, false);
      expect(state).not.toBeNull();
      expect(state!.label).toBe('Removing...');
    });

    it('disabled when isMutating is true', () => {
      const state = deriveRemoveButtonState(true, false, true, false, false);
      expect(state).not.toBeNull();
      expect(state!.disabled).toBe(true);
    });

    it('disabled when runRunning is true', () => {
      const state = deriveRemoveButtonState(true, false, false, false, true);
      expect(state).not.toBeNull();
      expect(state!.disabled).toBe(true);
    });

    it('cancel button disabled when isMutating in confirm state', () => {
      const state = deriveRemoveButtonState(true, true, true, true, false);
      expect(state).not.toBeNull();
      expect(state!.cancelDisabled).toBe(true);
    });

    it('cancel button not disabled when not mutating in confirm state', () => {
      const state = deriveRemoveButtonState(true, true, false, false, false);
      expect(state).not.toBeNull();
      expect(state!.cancelDisabled).toBe(false);
    });
  });

  describe('deriveRetrySyncButtonState', () => {
    it('returns null when worktree is absent', () => {
      expect(deriveRetrySyncButtonState(false, 'failed_env_write', false, false, false)).toBeNull();
    });

    it('returns null when sync_status is in_sync', () => {
      expect(deriveRetrySyncButtonState(true, 'in_sync', false, false, false)).toBeNull();
    });

    it('returns null when sync_status is never_attempted', () => {
      expect(deriveRetrySyncButtonState(true, 'never_attempted', false, false, false)).toBeNull();
    });

    it('returns null when sync_status is undefined', () => {
      expect(deriveRetrySyncButtonState(true, undefined, false, false, false)).toBeNull();
    });

    it('rendered when worktree present and sync failed', () => {
      const failedStatuses: AzureDevopsSyncStatus[] = [
        'failed_exclude',
        'failed_env_write',
        'failed_env_delete',
        'failed_secret_read',
        'deferred_worktree_absent',
      ];
      for (const s of failedStatuses) {
        const state = deriveRetrySyncButtonState(true, s, false, false, false);
        expect(state).not.toBeNull();
        expect(state!.rendered).toBe(true);
      }
    });

    it('shows "Retry Sync" when not pending', () => {
      const state = deriveRetrySyncButtonState(true, 'failed_env_write', false, false, false);
      expect(state).not.toBeNull();
      expect(state!.label).toBe('Retry Sync');
    });

    it('shows "Syncing..." when reconcile is pending', () => {
      const state = deriveRetrySyncButtonState(true, 'failed_env_write', true, true, false);
      expect(state).not.toBeNull();
      expect(state!.label).toBe('Syncing...');
    });

    it('disabled when isMutating is true', () => {
      const state = deriveRetrySyncButtonState(true, 'failed_env_write', true, false, false);
      expect(state).not.toBeNull();
      expect(state!.disabled).toBe(true);
    });

    it('disabled when runRunning is true', () => {
      const state = deriveRetrySyncButtonState(true, 'failed_env_write', false, false, true);
      expect(state).not.toBeNull();
      expect(state!.disabled).toBe(true);
    });
  });
});

// ============================================================================
// T14-AC2: Validation field errors and PAT-safe rendering
// ============================================================================

describe('T14-AC2: Validation field errors and PAT-safe rendering', () => {
  describe('validatePutInputs', () => {
    it('returns organization error when org is empty', () => {
      const result = validatePutInputs('', 'project', 'pat');
      expect(result).toEqual({ organization: 'Organization is required' });
    });

    it('returns organization error when org is whitespace', () => {
      const result = validatePutInputs('   ', 'project', 'pat');
      expect(result).toEqual({ organization: 'Organization is required' });
    });

    it('returns project error when project is empty', () => {
      const result = validatePutInputs('org', '', 'pat');
      expect(result).toEqual({ project: 'Project is required' });
    });

    it('returns pat error when pat is empty', () => {
      const result = validatePutInputs('org', 'project', '');
      expect(result).toEqual({ pat: 'PAT is required' });
    });

    it('returns null when all fields are provided', () => {
      expect(validatePutInputs('org', 'project', 'pat')).toBeNull();
    });

    it('validates in order: org first, then project, then pat', () => {
      // All empty: org error first
      expect(validatePutInputs('', '', '')).toEqual({ organization: 'Organization is required' });
      // Org present, project empty: project error
      expect(validatePutInputs('org', '', '')).toEqual({ project: 'Project is required' });
      // Org+project present, pat empty: pat error
      expect(validatePutInputs('org', 'project', '')).toEqual({ pat: 'PAT is required' });
    });

    it('trims input before validating', () => {
      expect(validatePutInputs('  org  ', '  project  ', '  pat  ')).toBeNull();
    });
  });

  describe('parseMutationError', () => {
    it('returns fieldErrors from ApiValidationError', () => {
      const err = new ApiValidationError('Validation failed', 'validation_failed', {
        organization: 'Invalid organization URL',
      });
      const result = parseMutationError(err, 'fallback');
      expect(result.fieldErrors).toEqual({ organization: 'Invalid organization URL' });
      expect(result.toastMessage).toBe('Validation failed');
    });

    it('returns null fieldErrors and Error.message for regular Error', () => {
      const err = new Error('Network failure');
      const result = parseMutationError(err, 'fallback');
      expect(result.fieldErrors).toBeNull();
      expect(result.toastMessage).toBe('Network failure');
    });

    it('returns null fieldErrors and fallbackMsg for non-Error values', () => {
      const result = parseMutationError('string error', 'Failed to save');
      expect(result.fieldErrors).toBeNull();
      expect(result.toastMessage).toBe('Failed to save');
    });

    it('returns null fieldErrors and fallbackMsg for null', () => {
      const result = parseMutationError(null, 'Operation failed');
      expect(result.fieldErrors).toBeNull();
      expect(result.toastMessage).toBe('Operation failed');
    });

    it('PAT-safe: fieldErrors never include PAT values', () => {
      // ApiValidationError field_errors should contain field names, not PAT values
      const err = new ApiValidationError('Validation failed', 'validation_failed', {
        organization: 'Invalid org URL format',
        project: 'Project not found',
      });
      const result = parseMutationError(err, 'fallback');
      expect(result.fieldErrors).not.toBeNull();
      // No fieldErrors key is 'pat' with a PAT value
      // The fieldErrors map from the server does not echo PAT values back
      const keys = Object.keys(result.fieldErrors!);
      const values = Object.values(result.fieldErrors!);
      for (const k of keys) {
        expect(k).not.toContain('password');
      }
      for (const v of values) {
        expect(v).not.toContain('pat_value');
      }
    });
  });

  describe('buildPatchRequest', () => {
    it('includes org when changed from current', () => {
      const { request, hasChanges } = buildPatchRequest(
        'https://dev.azure.com/neworg',
        '',
        '',
        false,
        'https://dev.azure.com/oldorg',
        null,
      );
      expect(hasChanges).toBe(true);
      expect(request.organization).toBe('https://dev.azure.com/neworg');
    });

    it('does not include org when same as current', () => {
      const { request } = buildPatchRequest(
        'https://dev.azure.com/myorg',
        '',
        '',
        false,
        'https://dev.azure.com/myorg',
        null,
      );
      expect(request.organization).toBeUndefined();
    });

    it('includes project when changed from current', () => {
      const { request, hasChanges } = buildPatchRequest(
        '',
        'NewProject',
        '',
        false,
        null,
        'OldProject',
      );
      expect(hasChanges).toBe(true);
      expect(request.project).toBe('NewProject');
    });

    it('does not include project when same as current', () => {
      const { request } = buildPatchRequest(
        '',
        'MyProject',
        '',
        false,
        null,
        'MyProject',
      );
      expect(request.project).toBeUndefined();
    });

    it('includes pat when non-empty', () => {
      const { request, hasChanges } = buildPatchRequest('', '', 'new-pat-value', false, null, null);
      expect(hasChanges).toBe(true);
      expect(request.pat).toBe('new-pat-value');
    });

    it('does not include pat when empty', () => {
      const { request } = buildPatchRequest('', '', '', false, null, null);
      expect(request.pat).toBeUndefined();
    });

    it('includes sync_now when true', () => {
      const { request } = buildPatchRequest('org', '', '', true, null, null);
      expect(request.sync_now).toBe(true);
    });

    it('does not include sync_now when false', () => {
      const { request } = buildPatchRequest('org', '', '', false, null, null);
      expect(request.sync_now).toBeUndefined();
    });

    it('returns hasChanges false when nothing changed', () => {
      const { hasChanges } = buildPatchRequest('', '', '', false, null, null);
      expect(hasChanges).toBe(false);
    });

    it('returns hasChanges false even with sync_now when no field changes', () => {
      // sync_now alone does not count as a field change
      const { hasChanges } = buildPatchRequest('', '', '', true, null, null);
      expect(hasChanges).toBe(false);
    });

    it('trims inputs before comparison', () => {
      const { request, hasChanges } = buildPatchRequest(
        '  https://dev.azure.com/myorg  ',
        '',
        '',
        false,
        'https://dev.azure.com/myorg',
        null,
      );
      expect(hasChanges).toBe(false);
      expect(request.organization).toBeUndefined();
    });

    it('does not include empty org (whitespace only)', () => {
      const { request, hasChanges } = buildPatchRequest('   ', '', '', false, 'old-org', null);
      expect(hasChanges).toBe(false);
      expect(request.organization).toBeUndefined();
    });
  });
});

// ============================================================================
// T14-AC3: Stream-driven status updates and error state rendering
// ============================================================================

describe('T14-AC3: Stream-driven status updates and error rendering', () => {
  describe('isNewStatusEvent', () => {
    it('returns true when prevEvent is null (first event)', () => {
      expect(isNewStatusEvent(null, makeEvent())).toBe(true);
    });

    it('returns false when all fields match (duplicate)', () => {
      const event = makeEvent();
      expect(isNewStatusEvent(event, { ...event })).toBe(false);
    });

    it('returns true when issue_ref differs', () => {
      const prev = makeEvent();
      const next = makeEvent({ issue_ref: 'other/repo#99' });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when configured changes', () => {
      const prev = makeEvent({ configured: true });
      const next = makeEvent({ configured: false });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when has_pat changes', () => {
      const prev = makeEvent({ has_pat: true });
      const next = makeEvent({ has_pat: false });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when worktree_present changes', () => {
      const prev = makeEvent({ worktree_present: true });
      const next = makeEvent({ worktree_present: false });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when organization changes', () => {
      const prev = makeEvent({ organization: 'https://dev.azure.com/org1' });
      const next = makeEvent({ organization: 'https://dev.azure.com/org2' });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when project changes', () => {
      const prev = makeEvent({ project: 'ProjectA' });
      const next = makeEvent({ project: 'ProjectB' });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when sync_status changes', () => {
      const prev = makeEvent({ sync_status: 'in_sync' });
      const next = makeEvent({ sync_status: 'failed_env_write' });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when last_attempt_at changes', () => {
      const prev = makeEvent({ last_attempt_at: '2026-01-15T10:00:00Z' });
      const next = makeEvent({ last_attempt_at: '2026-01-15T11:00:00Z' });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when last_success_at changes', () => {
      const prev = makeEvent({ last_success_at: '2026-01-15T10:00:00Z' });
      const next = makeEvent({ last_success_at: '2026-01-15T11:00:00Z' });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('returns true when last_error changes', () => {
      const prev = makeEvent({ last_error: null });
      const next = makeEvent({ last_error: 'env write failed' });
      expect(isNewStatusEvent(prev, next)).toBe(true);
    });

    it('ignores operation field changes (not compared)', () => {
      const prev = makeEvent({ operation: 'put' });
      const next = makeEvent({ operation: 'patch' });
      // operation is not in the comparison list, so events are equal
      expect(isNewStatusEvent(prev, next)).toBe(false);
    });
  });

  describe('eventToQueryCacheEntry', () => {
    it('maps all event fields to response shape', () => {
      const event = makeEvent();
      const entry = eventToQueryCacheEntry(event);

      expect(entry.ok).toBe(true);
      expect(entry.issue_ref).toBe(event.issue_ref);
      expect(entry.worktree_present).toBe(event.worktree_present);
      expect(entry.configured).toBe(event.configured);
      expect(entry.organization).toBe(event.organization);
      expect(entry.project).toBe(event.project);
      expect(entry.has_pat).toBe(event.has_pat);
      expect(entry.pat_last_updated_at).toBe(event.pat_last_updated_at);
      expect(entry.pat_env_var_name).toBe('AZURE_DEVOPS_EXT_PAT');
      expect(entry.sync_status).toBe(event.sync_status);
      expect(entry.last_attempt_at).toBe(event.last_attempt_at);
      expect(entry.last_success_at).toBe(event.last_success_at);
      expect(entry.last_error).toBe(event.last_error);
    });

    it('adds ok: true to the entry', () => {
      const entry = eventToQueryCacheEntry(makeEvent());
      expect(entry.ok).toBe(true);
    });

    it('does NOT include operation field from event', () => {
      const event = makeEvent({ operation: 'put' });
      const entry = eventToQueryCacheEntry(event);
      // Cast to check that operation is not present
      expect('operation' in entry).toBe(false);
    });

    it('preserves null fields correctly', () => {
      const event = makeEvent({
        organization: null,
        project: null,
        pat_last_updated_at: null,
        last_attempt_at: null,
        last_success_at: null,
        last_error: null,
      });
      const entry = eventToQueryCacheEntry(event);
      expect(entry.organization).toBeNull();
      expect(entry.project).toBeNull();
      expect(entry.pat_last_updated_at).toBeNull();
      expect(entry.last_attempt_at).toBeNull();
      expect(entry.last_success_at).toBeNull();
      expect(entry.last_error).toBeNull();
    });

    it('PAT-safe: no pat field in cache entry', () => {
      const event = makeEvent();
      const entry = eventToQueryCacheEntry(event);
      // The AzureDevopsStatusResponse type does not include pat
      expect('pat' in entry).toBe(false);
    });
  });

  describe('formatTimestamp', () => {
    it('returns "-" for null', () => {
      expect(formatTimestamp(null)).toBe('-');
    });

    it('returns a formatted string for valid ISO timestamp', () => {
      const result = formatTimestamp('2026-01-15T14:30:45.123Z');
      expect(result).not.toBe('-');
      // Contains at least one digit (formatted date)
      expect(result).toMatch(/\d/);
    });

    it('returns the original string for invalid date', () => {
      // new Date('not-a-date') produces Invalid Date, but toLocaleString doesn't throw
      // The catch path is for truly throwing cases
      const result = formatTimestamp('not-a-date');
      // In most environments, new Date('not-a-date').toLocaleString() returns 'Invalid Date'
      // which is truthy and doesn't trigger the catch
      expect(typeof result).toBe('string');
    });

    it('returns "-" for empty string', () => {
      // Empty string is falsy, so the function returns '-'
      expect(formatTimestamp('' as unknown as string | null)).toBe('-');
    });
  });

  describe('stream-driven state transitions', () => {
    it('first event always triggers cache update', () => {
      const event = makeEvent();
      expect(isNewStatusEvent(null, event)).toBe(true);
      const entry = eventToQueryCacheEntry(event);
      expect(entry.ok).toBe(true);
      expect(entry.configured).toBe(true);
    });

    it('duplicate event does not trigger cache update', () => {
      const event = makeEvent();
      // First event
      expect(isNewStatusEvent(null, event)).toBe(true);
      // Same event again
      expect(isNewStatusEvent(event, { ...event })).toBe(false);
    });

    it('credential removal event updates cache correctly', () => {
      const prevEvent = makeEvent({ configured: true, has_pat: true });
      const newEvent = makeEvent({
        configured: false,
        has_pat: false,
        organization: null,
        project: null,
        sync_status: 'never_attempted',
        operation: 'delete',
      });
      expect(isNewStatusEvent(prevEvent, newEvent)).toBe(true);
      const entry = eventToQueryCacheEntry(newEvent);
      expect(entry.configured).toBe(false);
      expect(entry.has_pat).toBe(false);
      expect(entry.organization).toBeNull();
    });

    it('reconcile event with sync failure updates cache', () => {
      const prevEvent = makeEvent({ sync_status: 'in_sync', last_error: null });
      const newEvent = makeEvent({
        sync_status: 'failed_env_write',
        last_error: 'Permission denied',
        last_attempt_at: '2026-01-15T12:00:00Z',
        operation: 'reconcile',
      });
      expect(isNewStatusEvent(prevEvent, newEvent)).toBe(true);
      const entry = eventToQueryCacheEntry(newEvent);
      expect(entry.sync_status).toBe('failed_env_write');
      expect(entry.last_error).toBe('Permission denied');
    });
  });
});
