/**
 * Sonar Token Management Page
 *
 * Allows users to:
 * - View token status (has token / sync status)
 * - Set or update the Sonar token (token is NEVER displayed after save)
 * - Configure the environment variable name (default: SONAR_TOKEN)
 * - Remove the token
 * - Retry sync to worktree
 *
 * SECURITY: The stored token value is NEVER displayed in the UI.
 */

import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_ENV_VAR_NAME } from '../api/sonarTokenTypes.js';
import type { SonarSyncStatus } from '../api/sonarTokenTypes.js';
import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import {
  useSonarTokenStatus,
  usePutSonarTokenMutation,
  useDeleteSonarTokenMutation,
  useReconcileSonarTokenMutation,
} from '../features/sonarToken/queries.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';
import './SonarTokenPage.css';

/**
 * Format a sync status for display.
 */
function formatSyncStatus(status: SonarSyncStatus): { label: string; color: string } {
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
      // Exhaustive check: this should never happen, but provide a safe fallback
      const _exhaustive: never = status;
      return { label: String(_exhaustive), color: 'var(--color-text-muted)' };
    }
  }
}

/**
 * Format an ISO timestamp for display.
 */
function formatTimestamp(isoString: string | null): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return d.toLocaleString();
  } catch {
    return isoString;
  }
}

export function SonarTokenPage() {
  const baseUrl = useViewerServerBaseUrl();
  const { pushToast } = useToast();
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;
  const currentIssueRef = stream.state?.issue_ref ?? null;

  // Form state - token input is cleared after save
  const [tokenInput, setTokenInput] = useState('');
  const [envVarNameInput, setEnvVarNameInput] = useState(DEFAULT_ENV_VAR_NAME);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  // Query and mutations
  const hasIssue = currentIssueRef !== null;
  const statusQuery = useSonarTokenStatus(baseUrl, hasIssue, currentIssueRef);
  const putMutation = usePutSonarTokenMutation(baseUrl, currentIssueRef);
  const deleteMutation = useDeleteSonarTokenMutation(baseUrl, currentIssueRef);
  const reconcileMutation = useReconcileSonarTokenMutation(baseUrl, currentIssueRef);

  const status = statusQuery.data;
  const isLoading = statusQuery.isLoading;
  const isMutating = putMutation.isPending || deleteMutation.isPending || reconcileMutation.isPending;

  // Update env var name input when status loads (use current config)
  useEffect(() => {
    if (status?.env_var_name) {
      setEnvVarNameInput(status.env_var_name);
    }
  }, [status?.env_var_name]);

  // Clear token input and confirm dialog when issue changes
  useEffect(() => {
    setTokenInput('');
    setShowRemoveConfirm(false);
  }, [currentIssueRef]);

  const handleSave = useCallback(async () => {
    const trimmedToken = tokenInput.trim();
    const trimmedEnvVarName = envVarNameInput.trim() || DEFAULT_ENV_VAR_NAME;

    // Validate that at least something will be saved
    if (!trimmedToken && trimmedEnvVarName === (status?.env_var_name ?? DEFAULT_ENV_VAR_NAME)) {
      pushToast('Enter a token or change the env var name');
      return;
    }

    try {
      const request: { token?: string; env_var_name?: string } = {};
      if (trimmedToken) {
        request.token = trimmedToken;
      }
      if (trimmedEnvVarName !== (status?.env_var_name ?? DEFAULT_ENV_VAR_NAME)) {
        request.env_var_name = trimmedEnvVarName;
      }
      // If we have a token but no env var name change, still include env_var_name for clarity
      if (trimmedToken && !request.env_var_name) {
        request.env_var_name = trimmedEnvVarName;
      }

      const response = await putMutation.mutateAsync(request);

      // Clear token input after successful save - token is NEVER displayed
      setTokenInput('');

      // Show success message
      if (response.warnings.length > 0) {
        pushToast(`Saved with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Token saved');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to save token');
    }
  }, [tokenInput, envVarNameInput, status?.env_var_name, putMutation, pushToast]);

  const handleRemove = useCallback(async () => {
    if (!showRemoveConfirm) {
      setShowRemoveConfirm(true);
      return;
    }

    try {
      const response = await deleteMutation.mutateAsync();
      setShowRemoveConfirm(false);

      if (response.warnings.length > 0) {
        pushToast(`Removed with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Token removed');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to remove token');
    }
  }, [showRemoveConfirm, deleteMutation, pushToast]);

  const handleCancelRemove = useCallback(() => {
    setShowRemoveConfirm(false);
  }, []);

  const handleRetrySync = useCallback(async () => {
    try {
      const response = await reconcileMutation.mutateAsync({ force: true });

      if (response.warnings.length > 0) {
        pushToast(`Sync completed with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Sync completed');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to sync');
    }
  }, [reconcileMutation, pushToast]);

  // No issue selected state
  if (!hasIssue) {
    return (
      <div className="sonar-token-page">
        <div className="panel">
          <div className="panelTitle">Sonar Token</div>
          <div className="panelBody">
            <div className="sonar-token-empty">
              <p>No issue selected.</p>
              <p className="muted">Select an issue from the sidebar to configure the Sonar token.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="sonar-token-page">
        <div className="panel">
          <div className="panelTitle">Sonar Token</div>
          <div className="panelBody">
            <div className="sonar-token-loading">Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (statusQuery.isError) {
    return (
      <div className="sonar-token-page">
        <div className="panel">
          <div className="panelTitle">Sonar Token</div>
          <div className="panelBody">
            <div className="sonar-token-error">
              <p>Failed to load token status.</p>
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
  const hasToken = status?.has_token ?? false;
  const worktreePresent = status?.worktree_present ?? false;
  // Check if sync is needed (any failed or pending status that isn't in_sync or never_attempted)
  const needsSync = status?.sync_status && status.sync_status !== 'in_sync' && status.sync_status !== 'never_attempted';
  // Allow retry sync when worktree is present and sync is needed, regardless of token state.
  // This handles cases like failed_env_delete where we need to clean up stale .env.jeeves.
  const canRetrySync = worktreePresent && needsSync;

  return (
    <div className="sonar-token-page">
      <div className="panel">
        <div className="panelTitle">Sonar Token</div>
        <div className="panelBody">
          {/* Status Section */}
          <div className="sonar-token-status-section">
            <div className="sonar-token-status-grid">
              <div className="sonar-token-status-item">
                <span className="sonar-token-status-label">Issue</span>
                <span className="sonar-token-status-value mono">{status?.issue_ref ?? '-'}</span>
              </div>
              <div className="sonar-token-status-item">
                <span className="sonar-token-status-label">Token Status</span>
                <span className="sonar-token-status-value">
                  {hasToken ? (
                    <span className="sonar-token-badge configured">Configured</span>
                  ) : (
                    <span className="sonar-token-badge not-configured">Not Configured</span>
                  )}
                </span>
              </div>
              <div className="sonar-token-status-item">
                <span className="sonar-token-status-label">Worktree</span>
                <span className="sonar-token-status-value">
                  {worktreePresent ? (
                    <span className="sonar-token-badge configured">Present</span>
                  ) : (
                    <span className="sonar-token-badge not-configured">Absent</span>
                  )}
                </span>
              </div>
              <div className="sonar-token-status-item">
                <span className="sonar-token-status-label">Sync Status</span>
                <span
                  className="sonar-token-status-value"
                  style={syncStatusInfo ? { color: syncStatusInfo.color } : undefined}
                >
                  {syncStatusInfo?.label ?? '-'}
                </span>
              </div>
              <div className="sonar-token-status-item">
                <span className="sonar-token-status-label">Last Attempt</span>
                <span className="sonar-token-status-value muted">
                  {formatTimestamp(status?.last_attempt_at ?? null)}
                </span>
              </div>
              <div className="sonar-token-status-item">
                <span className="sonar-token-status-label">Last Success</span>
                <span className="sonar-token-status-value muted">
                  {formatTimestamp(status?.last_success_at ?? null)}
                </span>
              </div>
            </div>

            {/* Last Error */}
            {status?.last_error && (
              <div className="sonar-token-last-error">
                <span className="sonar-token-status-label">Last Error</span>
                <div className="errorBox">{status.last_error}</div>
              </div>
            )}
          </div>

          {/* Run Warning */}
          {runRunning && (
            <div className="sonar-token-warning">
              A run is active. Token changes are disabled until the run completes.
            </div>
          )}

          {/* Configuration Form */}
          <div className="sonar-token-form-section">
            <div className="muted" style={{ marginBottom: 8, fontWeight: 500 }}>
              Configuration
            </div>

            <label className="label">
              Environment Variable Name
              <input
                className="input"
                value={envVarNameInput}
                onChange={(e) => setEnvVarNameInput(e.target.value.toUpperCase())}
                placeholder={DEFAULT_ENV_VAR_NAME}
                disabled={isMutating || runRunning}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                The variable name used in .env.jeeves (e.g., SONAR_TOKEN, SONARQUBE_TOKEN)
              </span>
            </label>

            <label className="label">
              {hasToken ? 'Update Token' : 'Token'}
              <input
                className="input"
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={hasToken ? 'Enter new token to update' : 'Enter your Sonar token'}
                disabled={isMutating || runRunning}
                autoComplete="off"
              />
              <span className="muted" style={{ fontSize: 12 }}>
                {hasToken
                  ? 'Leave empty to keep current token (only update env var name)'
                  : 'Token is stored securely and never displayed after save'}
              </span>
            </label>

            <div className="sonar-token-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => void handleSave()}
                disabled={isMutating || runRunning || (!tokenInput.trim() && envVarNameInput === (status?.env_var_name ?? DEFAULT_ENV_VAR_NAME))}
              >
                {putMutation.isPending ? 'Saving...' : hasToken ? 'Update' : 'Save'}
              </button>

              {hasToken && (
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
          <div className="sonar-token-help">
            <details>
              <summary>How it works</summary>
              <div className="sonar-token-help-content">
                <p>
                  This page manages your SonarQube/SonarCloud authentication token for the selected issue.
                </p>
                <ul>
                  <li>
                    <strong>Token Storage:</strong> Your token is stored securely in issue-scoped local state
                    (not in the git repository).
                  </li>
                  <li>
                    <strong>Worktree Sync:</strong> When you have an active worktree, the token is written to{' '}
                    <code>.env.jeeves</code> in the worktree root.
                  </li>
                  <li>
                    <strong>Git Ignore:</strong> The <code>.env.jeeves</code> file is automatically added to{' '}
                    <code>.git/info/exclude</code> so it won&apos;t be committed.
                  </li>
                  <li>
                    <strong>Auto-Sync:</strong> The token is automatically synced when you select an issue or
                    initialize a worktree.
                  </li>
                </ul>
                <p className="muted">
                  Usage: Source the env file in your shell with <code>source .env.jeeves</code> or configure
                  your tools to read from it.
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
