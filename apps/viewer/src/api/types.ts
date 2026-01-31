export type IssueListItem = Readonly<{
  owner: string;
  repo: string;
  issue_number: number;
  issue_title: string;
  branch: string | null;
  phase: string | null;
  state_dir: string;
}>;

export type IssueListResponse = Readonly<{
  ok: boolean;
  issues: IssueListItem[];
  current_issue: string | null;
  count?: number;
  data_dir?: string;
}>;

export type WorkflowPhase = Readonly<{
  id: string;
  name: string;
  type: string;
  description: string;
}>;

export type WorkflowResponse = Readonly<{
  ok: boolean;
  workflow_name: string;
  start_phase: string;
  current_phase: string;
  phases: WorkflowPhase[];
  phase_order: string[];
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
  viewer_log_file?: string | null;
}>;

export type ViewerPaths = Readonly<{
  dataDir: string;
  stateDir: string | null;
  workDir: string | null;
  workflowsDir: string;
  promptsDir: string;
}>;

export type IssueStateSnapshot = Readonly<{
  issue_ref: string | null;
  paths: ViewerPaths;
  issue_json: Record<string, unknown> | null;
  run: RunStatus;
}>;

export type PromptListResponse = Readonly<{ ok: boolean; prompts: { id: string }[]; count: number }>;
export type PromptGetResponse = Readonly<{ ok: boolean; id: string; content: string }>;

export type LogEvent = Readonly<{ lines: string[]; reset?: boolean }>;

export type SdkEvent = Readonly<{ event: string; data: unknown }>;

