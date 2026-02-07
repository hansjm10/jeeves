import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type {
  ProjectFilesStatusEvent,
  ProjectFilesSyncStatus,
} from '../api/projectFilesTypes.js';
import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { ApiValidationError } from '../features/projectFiles/api.js';
import {
  projectFilesQueryKey,
  useDeleteProjectFileMutation,
  useProjectFilesStatus,
  usePutProjectFileMutation,
  useReconcileProjectFilesMutation,
} from '../features/projectFiles/queries.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';
import './ProjectFilesPage.css';

function formatSyncStatus(status: ProjectFilesSyncStatus): { label: string; color: string } {
  switch (status) {
    case 'in_sync':
      return { label: 'In Sync', color: 'var(--color-accent-green)' };
    case 'deferred_worktree_absent':
      return { label: 'Pending (no worktree)', color: 'var(--color-accent-amber)' };
    case 'failed_conflict':
      return { label: 'Failed (conflict)', color: 'var(--color-accent-red)' };
    case 'failed_link_create':
      return { label: 'Failed (symlink create)', color: 'var(--color-accent-red)' };
    case 'failed_source_missing':
      return { label: 'Failed (source missing)', color: 'var(--color-accent-red)' };
    case 'failed_exclude':
      return { label: 'Failed (git exclude)', color: 'var(--color-accent-red)' };
    case 'never_attempted':
      return { label: 'Not synced yet', color: 'var(--color-text-muted)' };
    default: {
      const _exhaustive: never = status;
      return { label: String(_exhaustive), color: 'var(--color-text-muted)' };
    }
  }
}

function formatTimestamp(isoString: string | null): string {
  if (!isoString) return '-';
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

function statusEventChanged(prev: ProjectFilesStatusEvent | null, next: ProjectFilesStatusEvent): boolean {
  if (!prev) return true;
  if (prev.issue_ref !== next.issue_ref) return true;
  if (prev.sync_status !== next.sync_status) return true;
  if (prev.worktree_present !== next.worktree_present) return true;
  if (prev.file_count !== next.file_count) return true;
  if (prev.last_attempt_at !== next.last_attempt_at) return true;
  if (prev.last_success_at !== next.last_success_at) return true;
  if (prev.last_error !== next.last_error) return true;
  if (prev.operation !== next.operation) return true;
  if (prev.files.length !== next.files.length) return true;
  for (let i = 0; i < prev.files.length; i += 1) {
    const a = prev.files[i];
    const b = next.files[i];
    if (
      !b ||
      a.id !== b.id ||
      a.target_path !== b.target_path ||
      a.display_name !== b.display_name ||
      a.size_bytes !== b.size_bytes ||
      a.sha256 !== b.sha256 ||
      a.updated_at !== b.updated_at
    ) {
      return true;
    }
  }
  return false;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function ProjectFilesPage() {
  const baseUrl = useViewerServerBaseUrl();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;
  const currentIssueRef = stream.state?.issue_ref ?? null;

  const [targetPathInput, setTargetPathInput] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hasIssue = currentIssueRef !== null;
  const statusQuery = useProjectFilesStatus(baseUrl, hasIssue, currentIssueRef);
  const putMutation = usePutProjectFileMutation(baseUrl, currentIssueRef);
  const deleteMutation = useDeleteProjectFileMutation(baseUrl, currentIssueRef);
  const reconcileMutation = useReconcileProjectFilesMutation(baseUrl, currentIssueRef);

  const status = statusQuery.data;
  const isMutating = putMutation.isPending || deleteMutation.isPending || reconcileMutation.isPending;

  const projectFilesStatus = stream.projectFilesStatus;
  const prevEventRef = useRef<ProjectFilesStatusEvent | null>(null);

  useEffect(() => {
    if (!projectFilesStatus) return;

    if (statusEventChanged(prevEventRef.current, projectFilesStatus)) {
      queryClient.setQueryData(projectFilesQueryKey(baseUrl, projectFilesStatus.issue_ref), {
        ok: true as const,
        issue_ref: projectFilesStatus.issue_ref,
        worktree_present: projectFilesStatus.worktree_present,
        file_count: projectFilesStatus.file_count,
        files: projectFilesStatus.files,
        sync_status: projectFilesStatus.sync_status,
        last_attempt_at: projectFilesStatus.last_attempt_at,
        last_success_at: projectFilesStatus.last_success_at,
        last_error: projectFilesStatus.last_error,
      });
      prevEventRef.current = projectFilesStatus;
    }
  }, [projectFilesStatus, baseUrl, queryClient]);

  useEffect(() => {
    setFieldErrors({});
    setSelectedFile(null);
    setTargetPathInput('');
    setDisplayNameInput('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [currentIssueRef]);

  const handleUpload = useCallback(async () => {
    if (!selectedFile) {
      pushToast('Choose a file to upload.');
      return;
    }

    setFieldErrors({});

    const targetPath = targetPathInput.trim();
    if (!targetPath) {
      setFieldErrors({ target_path: 'Target path is required.' });
      return;
    }

    try {
      const contentBase64 = await fileToBase64(selectedFile);
      const response = await putMutation.mutateAsync({
        target_path: targetPath,
        display_name: displayNameInput.trim() || undefined,
        content_base64: contentBase64,
        sync_now: true,
      });

      setSelectedFile(null);
      setTargetPathInput('');
      setDisplayNameInput('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      if (response.warnings.length > 0) {
        pushToast(`Saved with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Project file saved');
      }
    } catch (err) {
      if (err instanceof ApiValidationError) {
        setFieldErrors(err.fieldErrors);
      }
      pushToast(err instanceof Error ? err.message : 'Failed to save project file');
    }
  }, [selectedFile, targetPathInput, displayNameInput, putMutation, pushToast]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      const response = await deleteMutation.mutateAsync(id);
      if (response.warnings.length > 0) {
        pushToast(`Deleted with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Project file deleted');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to delete project file');
    }
  }, [deleteMutation, pushToast]);

  const handleReconcile = useCallback(async () => {
    try {
      const response = await reconcileMutation.mutateAsync({ force: true });
      if (response.warnings.length > 0) {
        pushToast(`Reconcile finished with warnings: ${response.warnings.join(', ')}`);
      } else {
        pushToast('Reconcile completed');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Failed to reconcile project files');
    }
  }, [reconcileMutation, pushToast]);

  if (!hasIssue) {
    return (
      <div className="project-files-page">
        <div className="panel">
          <div className="panelTitle">Project Files</div>
          <div className="panelBody">
            <div className="project-files-empty">
              <p>No issue selected.</p>
              <p className="muted">Select an issue from the sidebar to manage project files.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (statusQuery.isLoading) {
    return (
      <div className="project-files-page">
        <div className="panel">
          <div className="panelTitle">Project Files</div>
          <div className="panelBody">
            <div className="project-files-loading">Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  if (statusQuery.isError) {
    return (
      <div className="project-files-page">
        <div className="panel">
          <div className="panelTitle">Project Files</div>
          <div className="panelBody">
            <div className="project-files-error">
              <p>Failed to load project files status.</p>
              <p className="muted">{statusQuery.error instanceof Error ? statusQuery.error.message : 'Unknown error'}</p>
              <button className="btn" type="button" onClick={() => void statusQuery.refetch()}>
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const syncStatusInfo = status ? formatSyncStatus(status.sync_status) : null;

  return (
    <div className="project-files-page">
      <div className="panel">
        <div className="panelTitle">Project Files</div>
        <div className="panelBody">
          <div className="project-files-status-section">
            <div className="project-files-status-grid">
              <div className="project-files-status-item">
                <span className="project-files-status-label">Issue</span>
                <span className="project-files-status-value mono">{status?.issue_ref ?? '-'}</span>
              </div>
              <div className="project-files-status-item">
                <span className="project-files-status-label">Files</span>
                <span className="project-files-status-value">{status?.file_count ?? 0}</span>
              </div>
              <div className="project-files-status-item">
                <span className="project-files-status-label">Worktree</span>
                <span className="project-files-status-value">
                  {status?.worktree_present ? (
                    <span className="project-files-badge configured">Present</span>
                  ) : (
                    <span className="project-files-badge not-configured">Absent</span>
                  )}
                </span>
              </div>
              <div className="project-files-status-item">
                <span className="project-files-status-label">Sync Status</span>
                <span
                  className="project-files-status-value"
                  style={syncStatusInfo ? { color: syncStatusInfo.color } : undefined}
                >
                  {syncStatusInfo?.label ?? '-'}
                </span>
              </div>
              <div className="project-files-status-item">
                <span className="project-files-status-label">Last Attempt</span>
                <span className="project-files-status-value muted">{formatTimestamp(status?.last_attempt_at ?? null)}</span>
              </div>
              <div className="project-files-status-item">
                <span className="project-files-status-label">Last Success</span>
                <span className="project-files-status-value muted">{formatTimestamp(status?.last_success_at ?? null)}</span>
              </div>
            </div>

            {status?.last_error ? (
              <div className="project-files-last-error">
                <span className="project-files-status-label">Last Error</span>
                <div className="errorBox">{status.last_error}</div>
              </div>
            ) : null}
          </div>

          {runRunning ? (
            <div className="project-files-warning">
              A run is active. Project file edits are disabled until the run completes.
            </div>
          ) : null}

          <div className="project-files-form-section">
            <div className="muted" style={{ marginBottom: 8, fontWeight: 500 }}>
              Upload / Update
            </div>

            <label className="label">
              File
              <input
                ref={fileInputRef}
                className="input"
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  setSelectedFile(file);
                  if (file && !targetPathInput.trim()) {
                    setTargetPathInput(file.name);
                  }
                  if (file && !displayNameInput.trim()) {
                    setDisplayNameInput(file.name);
                  }
                }}
                disabled={isMutating || runRunning}
              />
              <span className="muted" style={{ fontSize: 12 }}>
                Max size 1 MiB.
              </span>
            </label>

            <label className="label">
              Target Path (worktree relative)
              <input
                className={`input ${fieldErrors.target_path ? 'inputError' : ''}`}
                value={targetPathInput}
                onChange={(e) => setTargetPathInput(e.target.value)}
                placeholder="connections.local.config"
                disabled={isMutating || runRunning}
              />
              {fieldErrors.target_path ? <span className="errorText">{fieldErrors.target_path}</span> : null}
            </label>

            <label className="label">
              Display Name (optional)
              <input
                className={`input ${fieldErrors.display_name ? 'inputError' : ''}`}
                value={displayNameInput}
                onChange={(e) => setDisplayNameInput(e.target.value)}
                placeholder="connections.local.config"
                disabled={isMutating || runRunning}
              />
              {fieldErrors.display_name ? <span className="errorText">{fieldErrors.display_name}</span> : null}
            </label>

            <div className="project-files-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => void handleUpload()}
                disabled={isMutating || runRunning || !selectedFile}
              >
                {putMutation.isPending ? 'Saving...' : 'Save File'}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => void handleReconcile()}
                disabled={isMutating || runRunning}
              >
                {reconcileMutation.isPending ? 'Reconciling...' : 'Reconcile Now'}
              </button>
            </div>
          </div>

          <div className="project-files-list-section">
            <div className="muted" style={{ marginBottom: 8, fontWeight: 500 }}>
              Managed Files
            </div>

            {status?.files.length ? (
              <div className="project-files-list">
                {status.files.map((file) => (
                  <div key={file.id} className="project-files-row">
                    <div className="project-files-row-main">
                      <div className="project-files-row-title mono">{file.target_path}</div>
                      <div className="project-files-row-sub muted">
                        {file.display_name} | {formatBytes(file.size_bytes)} | updated {formatTimestamp(file.updated_at)}
                      </div>
                    </div>
                    <button
                      className="btn danger"
                      type="button"
                      onClick={() => void handleDelete(file.id)}
                      disabled={isMutating || runRunning}
                    >
                      {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">No managed project files configured.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
