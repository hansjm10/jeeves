/**
 * Types for project files management API.
 */

export type ProjectFilesSyncStatus =
  | 'in_sync'
  | 'deferred_worktree_absent'
  | 'failed_conflict'
  | 'failed_link_create'
  | 'failed_source_missing'
  | 'failed_exclude'
  | 'never_attempted';

export type ProjectFilesOperation =
  | 'put'
  | 'delete'
  | 'reconcile'
  | 'auto_reconcile';

export type ProjectFilePublic = Readonly<{
  id: string;
  display_name: string;
  target_path: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
}>;

export type ProjectFilesStatus = Readonly<{
  issue_ref: string;
  worktree_present: boolean;
  file_count: number;
  files: readonly ProjectFilePublic[];
  sync_status: ProjectFilesSyncStatus;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}>;

export type ProjectFilesStatusResponse = Readonly<{
  ok: true;
}> &
  ProjectFilesStatus;

export type ProjectFilesStatusEvent = ProjectFilesStatus &
  Readonly<{
    operation: ProjectFilesOperation;
  }>;

export type PutProjectFileRequest = Readonly<{
  id?: string;
  display_name?: string;
  target_path: string;
  content_base64: string;
  sync_now?: boolean;
}>;

export type ReconcileProjectFilesRequest = Readonly<{
  force?: boolean;
}>;

export type ProjectFilesMutateResponse = Readonly<{
  ok: true;
  updated: boolean;
  status: ProjectFilesStatus;
  warnings: string[];
  file?: ProjectFilePublic;
}>;

export type ProjectFilesErrorResponse = Readonly<{
  ok: false;
  error: string;
  code: string;
  field_errors?: Record<string, string>;
}>;
