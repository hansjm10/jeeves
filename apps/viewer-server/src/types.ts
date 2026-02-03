import type { CreateGitHubIssueParams, CreateGitHubIssueResult } from './githubIssueCreate.js';

export type IssueRefString = `${string}/${string}#${number}`;

export type RepoSpec = Readonly<{ owner: string; repo: string }>;

export type CreateGitHubIssueAdapter = (
  params: CreateGitHubIssueParams,
) => Promise<CreateGitHubIssueResult>;

export type ViewerPaths = Readonly<{
  dataDir: string;
  stateDir: string | null;
  workDir: string | null;
  workflowsDir: string;
  promptsDir: string;
}>;

/** Worker status during parallel execution */
export type WorkerStatusInfo = Readonly<{
  taskId: string;
  phase: 'implement_task' | 'task_spec_check';
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  returncode: number | null;
  status: 'running' | 'passed' | 'failed' | 'timed_out';
}>;

export type RunStatus = Readonly<{
  run_id?: string | null;
  run_dir?: string | null;
  running: boolean;
  pid: number | null;
  started_at: string | null;
  ended_at: string | null;
  returncode: number | null;
  command: string | null;
  max_iterations: number;
  current_iteration: number;
  completed_via_promise: boolean;
  completed_via_state: boolean;
  completion_reason: string | null;
  last_error: string | null;
  issue_ref: string | null;
  viewer_log_file: string | null;
  /** Active workers during parallel execution */
  workers?: WorkerStatusInfo[] | null;
  /** Max parallel tasks for this run (if parallel mode enabled) */
  max_parallel_tasks?: number | null;
}>;

export type IssueStateSnapshot = Readonly<{
  issue_ref: string | null;
  paths: ViewerPaths;
  issue_json: Record<string, unknown> | null;
  run: RunStatus;
}>;
