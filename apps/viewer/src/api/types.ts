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

export type WorkflowListItem = Readonly<{ name: string }>;

export type WorkflowListResponse = Readonly<{
  ok: true;
  workflows: WorkflowListItem[];
  workflows_dir: string;
}>;

export type WorkflowGetResponse = Readonly<{
  ok: true;
  name: string;
  yaml: string;
  workflow: Record<string, unknown>;
}>;

export type WorkflowSaveRequest = Readonly<{ workflow: unknown }>;
export type WorkflowCreateRequest = Readonly<{ name: string; from?: string }>;

export type IssueWorkflowSelectRequest = Readonly<{ workflow: string; reset_phase?: boolean }>;
export type IssueWorkflowSelectResponse = Readonly<{ ok: true; workflow: string; phase?: string }>;

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
  viewer_log_file?: string | null;
  /** Active workers during parallel execution */
  workers?: WorkerStatusInfo[] | null;
  /** Max parallel tasks for this run (if parallel mode enabled) */
  max_parallel_tasks?: number | null;
}>;

export type CreateIssueRunProvider = 'claude' | 'codex' | 'fake';

export type TaskExecutionMode = 'sequential' | 'parallel';

export type TaskExecutionSettings = Readonly<{
  mode: TaskExecutionMode;
  maxParallelTasks: number;
}>;

export type IssueSettings = Readonly<{
  taskExecution: TaskExecutionSettings;
}>;

/**
 * Input for starting a run via POST /api/run.
 * - provider: Required provider type
 * - max_iterations: Optional positive integer; omit to use server default (10)
 */
export type StartRunInput = Readonly<{
  provider: CreateIssueRunProvider;
  max_iterations?: number;
}>;

export type GetTaskExecutionResponse =
  | Readonly<{ ok: true; settings: IssueSettings }>
  | Readonly<{ ok: false; error: string }>;

export type SetTaskExecutionRequest = Readonly<{
  mode: TaskExecutionMode;
  maxParallelTasks?: number;
}>;

export type SetTaskExecutionResponse =
  | Readonly<{ ok: true; settings: IssueSettings }>
  | Readonly<{ ok: false; error: string }>;

export type CreateIssueInitParams = Readonly<{
  branch?: string;
  workflow?: string;
  phase?: string;
  design_doc?: string;
  force?: boolean;
}>;

export type CreateIssueAutoRunParams = Readonly<{
  provider?: CreateIssueRunProvider;
  workflow?: string;
  max_iterations?: number;
  inactivity_timeout_sec?: number;
  iteration_timeout_sec?: number;
}>;

export type CreateIssueRequest = Readonly<{
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  milestone?: string;
  init?: CreateIssueInitParams;
  auto_select?: boolean;
  auto_run?: CreateIssueAutoRunParams;
}>;

export type CreateIssueInitOkResult = Readonly<{
  issue_ref: string;
  state_dir: string;
  work_dir: string;
  repo_dir: string;
  branch: string;
}>;

export type CreateIssueInitResult =
  | Readonly<{ ok: true; result: CreateIssueInitOkResult }>
  | Readonly<{ ok: false; error: string }>;

export type CreateIssueAutoRunResult =
  | Readonly<{ ok: true; run_started: true }>
  | Readonly<{ ok: false; run_started: false; error: string }>;

export type CreateIssueSuccessResponse = Readonly<{
  ok: true;
  created: true;
  issue_url: string;
  issue_ref?: string;
  init?: CreateIssueInitResult;
  auto_run?: CreateIssueAutoRunResult;
  run: RunStatus;
}>;

export type CreateIssueErrorResponse = Readonly<{
  ok: false;
  error: string;
  run: RunStatus;
}>;

export type CreateIssueResponse = CreateIssueSuccessResponse | CreateIssueErrorResponse;

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
  /** Total number of tasks in tasks.json (null when no tasks file exists) */
  task_count?: number | null;
}>;

export type PromptListResponse = Readonly<{ ok: boolean; prompts: { id: string }[]; count: number }>;
export type PromptGetResponse = Readonly<{ ok: boolean; id: string; content: string }>;

export type LogEvent = Readonly<{ lines: string[]; reset?: boolean }>;

export type SdkEvent = Readonly<{ event: string; data: unknown }>;

// SDK Event Data Types
export type SdkInitData = Readonly<{
  session_id: string;
  started_at: string;
  status: string;
}>;

export type SdkToolStartData = Readonly<{
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
}>;

export type SdkToolCompleteData = Readonly<{
  tool_use_id: string;
  name: string;
  duration_ms: number;
  is_error: boolean;
}>;

export type SdkMessageData = Readonly<{
  message: string;
  index: number;
  total: number;
}>;

export type SdkCompleteSummary = Readonly<{
  message_count?: number;
  tool_call_count?: number;
  duration_seconds?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number | null;
  num_turns?: number;
}>;

export type SdkCompleteData = Readonly<{
  status: string;
  summary?: SdkCompleteSummary;
}>;

// Tool Input Types for specific tools
export type BashToolInput = Readonly<{
  command: string;
  description?: string;
  timeout?: number;
}>;

export type ReadToolInput = Readonly<{
  file_path: string;
  offset?: number;
  limit?: number;
}>;

export type WriteToolInput = Readonly<{
  file_path: string;
  content: string;
}>;

export type EditToolInput = Readonly<{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}>;

export type GlobToolInput = Readonly<{
  pattern: string;
  path?: string;
}>;

export type GrepToolInput = Readonly<{
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
}>;

export type TaskToolInput = Readonly<{
  prompt: string;
  description: string;
  subagent_type: string;
  model?: string;
}>;

// Issue Expansion Types
export type IssueType = 'feature' | 'bug' | 'refactor';

export type ExpandIssueRequest = Readonly<{
  summary: string;
  issue_type?: IssueType;
  provider?: string;
  model?: string;
}>;

export type ExpandIssueSuccessResponse = Readonly<{
  ok: true;
  title: string;
  body: string;
  provider: string;
  model?: string;
}>;

export type ExpandIssueErrorResponse = Readonly<{
  ok: false;
  error: string;
}>;

export type ExpandIssueResponse = ExpandIssueSuccessResponse | ExpandIssueErrorResponse;

// Union type for all tool inputs
export type ToolInput =
  | BashToolInput
  | ReadToolInput
  | WriteToolInput
  | EditToolInput
  | GlobToolInput
  | GrepToolInput
  | TaskToolInput
  | Record<string, unknown>;

// ============================================================================
// Sonar Token Types (re-exported from sonarTokenTypes for convenience)
// ============================================================================

export type { SonarTokenStatusEvent, SonarSyncStatus } from './sonarTokenTypes.js';

// ============================================================================
// Azure DevOps Types (re-exported from azureDevopsTypes for convenience)
// ============================================================================

export type {
  AzureDevopsStatusEvent,
  AzureDevopsSyncStatus,
  IssueIngestStatusEvent,
  IssueProvider,
  IngestMode,
  IngestOutcome,
  IngestEventOutcome,
} from './azureDevopsTypes.js';

// ============================================================================
// Project Files Types (re-exported for convenience)
// ============================================================================

export type {
  ProjectFilesStatusEvent,
  ProjectFilesSyncStatus,
} from './projectFilesTypes.js';
