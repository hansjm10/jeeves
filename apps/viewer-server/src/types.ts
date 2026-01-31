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

export type RunStatus = Readonly<{
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
}>;

export type IssueStateSnapshot = Readonly<{
  issue_ref: string | null;
  paths: ViewerPaths;
  issue_json: Record<string, unknown> | null;
  run: RunStatus;
}>;
