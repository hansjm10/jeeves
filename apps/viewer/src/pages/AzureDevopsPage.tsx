/**
 * Azure DevOps Credential Management Page
 *
 * Allows users to:
 * - View credential status (configured / sync status)
 * - Set or update Azure DevOps credentials (PAT is NEVER displayed after save)
 * - Configure organization and project
 * - Partially update fields via PATCH
 * - Remove credentials
 * - Retry sync to worktree
 *
 * SECURITY: The stored PAT value is NEVER displayed in the UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { AzureDevopsSyncStatus, AzureDevopsStatusEvent } from '../api/azureDevopsTypes.js';
import { AZURE_PAT_ENV_VAR_NAME } from '../api/azureDevopsTypes.js';
import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { ApiValidationError } from '../features/azureDevops/api.js';
import {
  useAzureDevopsStatus,
  usePutAzureDevopsMutation,
  usePatchAzureDevopsMutation,
  useDeleteAzureDevopsMutation,
  useReconcileAzureDevopsMutation,
  azureDevopsQueryKey,
} from '../features/azureDevops/queries.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';
import './AzureDevopsPage.css';

/**
 * Format a sync status for display.
 */
export function formatSyncStatus(status: AzureDevopsSyncStatus): { label: string; color: string } {
  switch (status) {
    case 'in_sync':
      return { label: 'In Sync', color: 'var(--color-accent-green)' };
    case 'deferred_worktree_absent':
      return { label: 'Pending (no worktree)', color: 'var(--color-accent-amber)' };
    case 'failed_exclude':
      return { label: 'Failed (git exclude)', color: 'var(--color-accent-red)' };
    case 'failed_env_write':
      return { label: 'Failed (env write)', color: 'var(--color-accent-red)' };
    case 'failed_env_delete':
      return { label: 'Failed (env delete)', color: 'var(--color-accent-red)' };
    case 'failed_secret_read':
      return { label: 'Failed (secret read)', color: 'var(--color-accent-red)' };
    case 'never_attempted':
      return { label: 'Not synced yet', color: 'var(--color-text-muted)' };
    default: {
      const _exhaustive: never = status;
      return { label: String(_exhaustive), color: 'var(--color-text-muted)' };
    }
  }
}

/**
 * Format an ISO timestamp for display.
 */
export function formatTimestamp(isoString: string | null): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleString();
  } catch {
    return isoString;
  }
}

// ============================================================================
// Extracted pure helpers for testability
// ============================================================================

/**
 * Check whether a new azure-devops-status event differs from the previous one.
 * Used to deduplicate stream events before updating the query cache.
 */
export function isNewStatusEvent(
  prevEvent: AzureDevopsStatusEvent | null,
  newEvent: AzureDevopsStatusEvent,
): boolean {
  if (!prevEvent) return true;
  return (
    prevEvent.issue_ref !== newEvent.issue_ref ||
    prevEvent.configured !== newEvent.configured ||
    prevEvent.has_pat !== newEvent.has_pat ||
    prevEvent.worktree_present !== newEvent.worktree_present ||
    prevEvent.organization !== newEvent.organization ||
    prevEvent.project !== newEvent.project ||
    prevEvent.sync_status !== newEvent.sync_status ||
    prevEvent.last_attempt_at !== newEvent.last_attempt_at ||
    prevEvent.last_success_at !== newEvent.last_success_at ||
    prevEvent.last_error !== newEvent.last_error
  );
}

/**
 * Transform an AzureDevopsStatusEvent into the shape needed for the query cache entry.
 * The `operation` field from the event is NOT included in the cache entry.
 */
export function eventToQueryCacheEntry(event: AzureDevopsStatusEvent): {
  ok: true;
  issue_ref: string;
  worktree_present: boolean;
  configured: boolean;
  organization: string | null;
  project: string | null;
  has_pat: boolean;
  pat_last_updated_at: string | null;
  pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT';
  sync_status: AzureDevopsSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
} {
  return {
    ok: true as const,
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
 * Derive the save button's label and disabled state.
 */
export function deriveSaveButtonState(
  isConfigured: boolean,
  isMutating: boolean,
  isPutPending: boolean,
  isPatchPending: boolean,
  runRunning: boolean,
): { disabled: boolean; label: string } {
  const label = isPutPending || isPatchPending
    ? 'Saving...'
    : isConfigured
      ? 'Update'
      : 'Save';
  return { disabled: isMutating || runRunning, label };
}

/**
 * Derive the remove button section state. Returns null when the button should not be rendered.
 */
export function deriveRemoveButtonState(
  isConfigured: boolean,
  showRemoveConfirm: boolean,
  isMutating: boolean,
  isDeletePending: boolean,
  runRunning: boolean,
): {
  rendered: true;
  showConfirm: boolean;
  disabled: boolean;
  label: string;
  cancelDisabled: boolean;
} | null {
  if (!isConfigured) return null;
  if (showRemoveConfirm) {
    return {
      rendered: true,
      showConfirm: true,
      disabled: isMutating || runRunning,
      label: isDeletePending ? 'Removing...' : 'Confirm Remove',
      cancelDisabled: isMutating,
    };
  }
  return {
    rendered: true,
    showConfirm: false,
    disabled: isMutating || runRunning,
    label: 'Remove',
    cancelDisabled: false,
  };
}

/**
 * Derive the retry sync button state. Returns null when the button should not be rendered.
 */
export function deriveRetrySyncButtonState(
  worktreePresent: boolean,
  syncStatus: AzureDevopsSyncStatus | undefined,
  isMutating: boolean,
  isReconcilePending: boolean,
  runRunning: boolean,
): { rendered: true; disabled: boolean; label: string } | null {
  const needsSync = syncStatus && syncStatus !== 'in_sync' && syncStatus !== 'never_attempted';
  const canRetrySync = worktreePresent && needsSync;
  if (!canRetrySync) return null;
  return {
    rendered: true,
    disabled: isMutating || runRunning,
    label: isReconcilePending ? 'Syncing...' : 'Retry Sync',
  };
}

/**
 * Build a PATCH request from current form inputs and existing status values.
 * Returns the request object and a flag indicating whether anything changed.
 */
export function buildPatchRequest(
  orgInput: string,
  projectInput: string,
  patInput: string,
  syncNow: boolean,
  currentOrg: string | null | undefined,
  currentProject: string | null | undefined,
): { request: Record<string, unknown>; hasChanges: boolean } {
  const trimmedOrg = orgInput.trim();
  const trimmedProject = projectInput.trim();
  const trimmedPat = patInput.trim();

  const request: Record<string, unknown> = {};
  let hasChanges = false;

  if (trimmedOrg && trimmedOrg !== (currentOrg ?? '')) {
    request.organization = trimmedOrg;
    hasChanges = true;
  }
  if (trimmedProject && trimmedProject !== (currentProject ?? '')) {
    request.project = trimmedProject;
    hasChanges = true;
  }
  if (trimmedPat) {
    request.pat = trimmedPat;
    hasChanges = true;
  }
  if (syncNow) {
    request.sync_now = true;
  }

  return { request, hasChanges };
}

/**
 * Validate the inputs for a PUT (full setup) operation.
 * Returns field errors or null if all inputs are valid.
 */
export function validatePutInputs(
  org: string,
  project: string,
  pat: string,
): Record<string, string> | null {
  const trimmedOrg = org.trim();
  const trimmedProject = project.trim();
  const trimmedPat = pat.trim();

  if (!trimmedOrg) return { organization: 'Organization is required' };
  if (!trimmedProject) return { project: 'Project is required' };
  if (!trimmedPat) return { pat: 'PAT is required' };
  return null;
}

/**
 * Parse a mutation error into field errors and a toast message.
 * Extracts field_errors from ApiValidationError while keeping the PAT safe.
 */
export function parseMutationError(
  err: unknown,
  fallbackMsg: string,
): { fieldErrors: Record<string, string> | null; toastMessage: string } {
  if (err instanceof ApiValidationError) {
    return { fieldErrors: err.fieldErrors, toastMessage: err.message };
  }
  return {
    fieldErrors: null,
    toastMessage: err instanceof Error ? err.message : fallbackMsg,
  };
}

export function AzureDevopsPage() {
  const baseUrl = useViewerServerBaseUrl();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;
  const currentIssueRef = stream.state?.issue_ref ?? null;

  // Form state - PAT input is cleared after save
  const [orgInput, setOrgInput] = useState('');
  const [projectInput, setProjectInput] = useState('');
  const [patInput, setPatInput] = useState('');
  const [syncNow, setSyncNow] = useState(true);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Query and mutations
  const hasIssue = currentIssueRef !== null;
  const statusQuery = useAzureDevopsStatus(baseUrl, hasIssue, currentIssueRef);
  const putMutation = usePutAzureDevopsMutation(baseUrl, currentIssueRef);
  const patchMutation = usePatchAzureDevopsMutation(baseUrl, currentIssueRef);
  const deleteMutation = useDeleteAzureDevopsMutation(baseUrl, currentIssueRef);
  const reconcileMutation = useReconcileAzureDevopsMutation(baseUrl, currentIssueRef);

  const status = statusQuery.data;
  const isLoading = statusQuery.isLoading;
  const isMutating =
    putMutation.isPending || patchMutation.isPending ||
    deleteMutation.isPending || reconcileMutation.isPending;

  // Stream sync: auto-update query cache when azure-devops-status events arrive
  const azureDevopsStatus = stream.azureDevopsStatus;
  const prevEventRef = useRef<AzureDevopsStatusEvent | null>(null);

  useEffect(() => {
    if (!azureDevopsStatus) return;

    if (isNewStatusEvent(prevEventRef.current, azureDevopsStatus)) {
      queryClient.setQueryData(
        azureDevopsQueryKey(baseUrl, azureDevopsStatus.issue_ref),
        eventToQueryCacheEntry(azureDevopsStatus),
      );
      prevEventRef.current = azureDevopsStatus;
    }
  }, [azureDevopsStatus, baseUrl, queryClient]);

  // Update org/project inputs when status loads
  useEffect(() => {
    if (status?.organization) {
      setOrgInput(status.organization);
    }
    if (status?.project) {
      setProjectInput(status.project);
    }
  }, [status?.organization, status?.project]);

  // Clear inputs and confirm dialog when issue changes
  useEffect(() => {
    setPatInput('');
    setShowRemoveConfirm(false);
    setFieldErrors({});
  }, [currentIssueRef]);

  /**
   * Handle mutation errors, extracting field_errors from ApiValidationError.
   */
  function handleMutationError(err: unknown, fallbackMsg: string): void {
    const parsed = parseMutationError(err, fallbackMsg);
    if (parsed.fieldErrors) {
      setFieldErrors(parsed.fieldErrors);
    }
    pushToast(parsed.toastMessage);
  }

  const handleSave = useCallback(async () => {
    setFieldErrors({});
    const trimmedOrg = orgInput.trim();
    const trimmedProject = projectInput.trim();
    const trimmedPat = patInput.trim();

    const isConfigured = status?.configured ?? false;

    if (isConfigured) {
      // PATCH mode: update only changed fields
      const patchRequest: Record<string, unknown> = {};
      let hasChanges = false;

      if (trimmedOrg && trimmedOrg !== (status?.organization ?? '')) {
        patchRequest.organization = trimmedOrg;
        hasChanges = true;
      }
      if (trimmedProject && trimmedProject !== (status?.project ?? '')) {
        patchRequest.project = trimmedProject;
        hasChanges = true;
      }
      if (trimmedPat) {
        patchRequest.pat = trimmedPat;
        hasChanges = true;
      }
      if (syncNow) {
        patchRequest.sync_now = true;
      }

      if (!hasChanges) {
        pushToast('No changes to save');
        return;
      }

      try {
        const response = await patchMutation.mutateAsync(
          patchRequest as { organization?: string; project?: string; pat?: string; sync_now?: boolean },
        );
        setPatInput('');
        if (response.warnings.length > 0) {
          pushToast(`Updated with warnings: ${response.warnings.join(', ')}`);
        } else {
          pushToast('Credentials updated');
        }
      } catch (err) {
        handleMutationError(err, 'Failed to update credentials');
      }
    } else {
      // PUT mode: full setup
      if (!trimmedOrg) {
        setFieldErrors({ organization: 'Organization is required' });
        return;
      }
      if (!trimmedProject) {
        setFieldErrors({ project: 'Project is required' });
        return;
      }
      if (!trimmedPat) {
        setFieldErrors({ pat: 'PAT is required' });
        return;
      }

      try {
        const response = await putMutation.mutateAsync({
          organization: trimmedOrg,
          project: trimmedProject,
          pat: trimmedPat,
          sync_now: syncNow,
        });
        setPatInput('');
        if (response.warnings.length > 0) {
          pushToast(`Saved with warnings: ${response.warnings.join(', ')}`);
        } else {
          pushToast('Credentials saved');
        }
      } catch (err) {
        handleMutationError(err, 'Failed to save credentials');
      }
    }
  }, [orgInput, projectInput, patInput, syncNow, status, putMutation, patchMutation, pushToast]);

  const handleRemove = useCallback(async () => {
    if (!showRemoveConfirm) {
      setShowRemoveConfirm(true);
      return;
    }

    setFieldErrors({});
    try {
      const response = await deleteMutation.mutateAsync();
      setShowRemoveConfirm(false);
      setOrgInput('');
      setProjectInput('');
      setPatInput('');

      if (response.warnings.length > 0) {
        pushToast(`Removed with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Credentials removed');
      }
    } catch (err) {
      handleMutationError(err, 'Failed to remove credentials');
    }
  }, [showRemoveConfirm, deleteMutation, pushToast]);

  const handleCancelRemove = useCallback(() => {
    setShowRemoveConfirm(false);
  }, []);

  const handleRetrySync = useCallback(async () => {
    setFieldErrors({});
    try {
      const response = await reconcileMutation.mutateAsync({ force: true });

      if (response.warnings.length > 0) {
        pushToast(`Sync completed with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Sync completed');
      }
    } catch (err) {
      handleMutationError(err, 'Failed to sync');
    }
  }, [reconcileMutation, pushToast]);

  // No issue selected state
  if (!hasIssue) {
    return (
      <div className="azure-devops-page">
        <div className="panel">
          <div className="panelTitle">Azure DevOps</div>
          <div className="panelBody">
            <div className="azure-devops-empty">
              <p>No issue selected.</p>
              <p className="muted">Select an issue from the sidebar to configure Azure DevOps credentials.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="azure-devops-page">
        <div className="panel">
          <div className="panelTitle">Azure DevOps</div>
          <div className="panelBody">
            <div className="azure-devops-loading">Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (statusQuery.isError) {
    return (
      <div className="azure-devops-page">
        <div className="panel">
          <div className="panelTitle">Azure DevOps</div>
          <div className="panelBody">
            <div className="azure-devops-error">
              <p>Failed to load Azure DevOps status.</p>
              <p className="muted">
                {statusQuery.error instanceof Error ? statusQuery.error.message : 'Unknown error'}
              </p>
              <button
                className="btn"
                type="button"
                onClick={() => void statusQuery.refetch()}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const syncStatusInfo = status ? formatSyncStatus(status.sync_status) : null;
  const isConfigured = status?.configured ?? false;
  const hasPat = status?.has_pat ?? false;
  const worktreePresent = status?.worktree_present ?? false;
  const needsSync = status?.sync_status && status.sync_status !== 'in_sync' && status.sync_status !== 'never_attempted';
  const canRetrySync = worktreePresent && needsSync;

  return (
    <div className="azure-devops-page">
      <div className="panel">
        <div className="panelTitle">Azure DevOps</div>
        <div className="panelBody">
          {/* Status Section */}
          <div className="azure-devops-status-section">
            <div className="azure-devops-status-grid">
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Issue</span>
                <span className="azure-devops-status-value mono">{status?.issue_ref ?? '-'}</span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Status</span>
                <span className="azure-devops-status-value">
                  {isConfigured ? (
                    <span className="azure-devops-badge configured">Configured</span>
                  ) : (
                    <span className="azure-devops-badge not-configured">Not Configured</span>
                  )}
                </span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Organization</span>
                <span className="azure-devops-status-value mono">{status?.organization ?? '-'}</span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Project</span>
                <span className="azure-devops-status-value mono">{status?.project ?? '-'}</span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">PAT</span>
                <span className="azure-devops-status-value">
                  {hasPat ? (
                    <span className="azure-devops-badge configured">Set</span>
                  ) : (
                    <span className="azure-devops-badge not-configured">Not Set</span>
                  )}
                </span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Worktree</span>
                <span className="azure-devops-status-value">
                  {worktreePresent ? (
                    <span className="azure-devops-badge configured">Present</span>
                  ) : (
                    <span className="azure-devops-badge not-configured">Absent</span>
                  )}
                </span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Sync Status</span>
                <span
                  className="azure-devops-status-value"
                  style={syncStatusInfo ? { color: syncStatusInfo.color } : undefined}
                >
                  {syncStatusInfo?.label ?? '-'}
                </span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Last Attempt</span>
                <span className="azure-devops-status-value muted">
                  {formatTimestamp(status?.last_attempt_at ?? null)}
                </span>
              </div>
              <div className="azure-devops-status-item">
                <span className="azure-devops-status-label">Last Success</span>
                <span className="azure-devops-status-value muted">
                  {formatTimestamp(status?.last_success_at ?? null)}
                </span>
              </div>
            </div>

            {/* Last Error */}
            {status?.last_error && (
              <div className="azure-devops-last-error">
                <span className="azure-devops-status-label">Last Error</span>
                <div className="errorBox">{status.last_error}</div>
              </div>
            )}
          </div>

          {/* Run Warning */}
          {runRunning && (
            <div className="azure-devops-warning">
              A run is active. Credential changes are disabled until the run completes.
            </div>
          )}

          {/* Configuration Form */}
          <div className="azure-devops-form-section">
            <div className="muted" style={{ marginBottom: 8, fontWeight: 500 }}>
              Configuration
            </div>

            <label className="label">
              Organization URL
              <input
                className="input"
                value={orgInput}
                onChange={(e) => {
                  setOrgInput(e.target.value);
                  if (fieldErrors.organization) {
                    setFieldErrors((prev) => { const next = { ...prev }; delete next.organization; return next; });
                  }
                }}
                placeholder="https://dev.azure.com/your-org"
                disabled={isMutating || runRunning}
              />
              {fieldErrors.organization && (
                <span className="azure-devops-field-error">{fieldErrors.organization}</span>
              )}
              <span className="muted" style={{ fontSize: 12 }}>
                The Azure DevOps organization URL (e.g., https://dev.azure.com/myorg)
              </span>
            </label>

            <label className="label">
              Project
              <input
                className="input"
                value={projectInput}
                onChange={(e) => {
                  setProjectInput(e.target.value);
                  if (fieldErrors.project) {
                    setFieldErrors((prev) => { const next = { ...prev }; delete next.project; return next; });
                  }
                }}
                placeholder="MyProject"
                disabled={isMutating || runRunning}
              />
              {fieldErrors.project && (
                <span className="azure-devops-field-error">{fieldErrors.project}</span>
              )}
            </label>

            <label className="label">
              {hasPat ? 'Update PAT' : 'Personal Access Token (PAT)'}
              <input
                className="input"
                type="password"
                value={patInput}
                onChange={(e) => {
                  setPatInput(e.target.value);
                  if (fieldErrors.pat) {
                    setFieldErrors((prev) => { const next = { ...prev }; delete next.pat; return next; });
                  }
                }}
                placeholder={hasPat ? 'Enter new PAT to update' : 'Enter your Azure DevOps PAT'}
                disabled={isMutating || runRunning}
                autoComplete="off"
              />
              {fieldErrors.pat && (
                <span className="azure-devops-field-error">{fieldErrors.pat}</span>
              )}
              <span className="muted" style={{ fontSize: 12 }}>
                {hasPat
                  ? 'Leave empty to keep current PAT (only update org/project)'
                  : 'PAT is stored securely and never displayed after save'}
              </span>
            </label>

            <label
              className="label"
              style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}
            >
              <input
                type="checkbox"
                checked={syncNow}
                onChange={(e) => setSyncNow(e.target.checked)}
                disabled={isMutating || runRunning}
              />
              Sync to worktree after save
            </label>

            <div className="azure-devops-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => void handleSave()}
                disabled={isMutating || runRunning}
              >
                {putMutation.isPending || patchMutation.isPending
                  ? 'Saving...'
                  : isConfigured
                    ? 'Update'
                    : 'Save'}
              </button>

              {isConfigured && (
                <>
                  {showRemoveConfirm ? (
                    <>
                      <button
                        className="btn danger"
                        type="button"
                        onClick={() => void handleRemove()}
                        disabled={isMutating || runRunning}
                      >
                        {deleteMutation.isPending ? 'Removing...' : 'Confirm Remove'}
                      </button>
                      <button
                        className="btn"
                        type="button"
                        onClick={handleCancelRemove}
                        disabled={isMutating}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void handleRemove()}
                      disabled={isMutating || runRunning}
                    >
                      Remove
                    </button>
                  )}
                </>
              )}

              {canRetrySync && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => void handleRetrySync()}
                  disabled={isMutating || runRunning}
                >
                  {reconcileMutation.isPending ? 'Syncing...' : 'Retry Sync'}
                </button>
              )}
            </div>
          </div>

          {/* Help Section */}
          <div className="azure-devops-help">
            <details>
              <summary>How it works</summary>
              <div className="azure-devops-help-content">
                <p>
                  This page manages your Azure DevOps Personal Access Token (PAT) for the selected issue.
                </p>
                <ul>
                  <li>
                    <strong>PAT Storage:</strong> Your PAT is stored securely in issue-scoped local state
                    (not in the git repository).
                  </li>
                  <li>
                    <strong>Worktree Sync:</strong> When you have an active worktree, the PAT is written to{' '}
                    <code>.env.jeeves</code> as <code>{AZURE_PAT_ENV_VAR_NAME}</code>.
                  </li>
                  <li>
                    <strong>Git Ignore:</strong> The <code>.env.jeeves</code> file is automatically added to{' '}
                    <code>.git/info/exclude</code> so it won&apos;t be committed.
                  </li>
                  <li>
                    <strong>Auto-Sync:</strong> Credentials are automatically synced when you select an issue or
                    initialize a worktree.
                  </li>
                </ul>
                <p className="muted">
                  The PAT is used for Azure DevOps API access (work items, PRs, etc.)
                  and is never exposed in logs, events, or UI.
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
