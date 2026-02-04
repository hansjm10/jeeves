import { useEffect, useMemo, useState } from 'react';

import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import type { TaskExecutionMode } from '../api/types.js';
import { useInitIssueMutation, useSelectIssueMutation, useSetIssuePhaseMutation, useSetTaskExecutionMutation, useStartRunMutation, useStopRunMutation } from '../features/mutations.js';
import { useIssuesQuery } from '../features/issues/queries.js';
import { groupForPhase, pickGroupTarget, type GroupPhase } from '../features/workflow/phaseGroups.js';
import { useWorkflowQuery } from '../features/workflow/queries.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';

const PROVIDERS = ['claude', 'codex', 'fake'] as const;
type Provider = (typeof PROVIDERS)[number];
const PROVIDER_STORAGE_KEY = 'jeeves.provider';
export const ITERATIONS_STORAGE_KEY = 'jeeves.iterations';
export const MAX_PARALLEL_TASKS = 8;

function normalizeProvider(value: unknown): Provider {
  if (value === 'claude' || value === 'codex' || value === 'fake') return value;
  return 'claude';
}

/**
 * Validates iterations input and returns the parsed value or null if invalid.
 * Valid: positive integers (1, 2, 3, ...)
 * Invalid: 0, negative, non-integer (2.5), non-numeric ('abc'), blank/empty
 * Returns: { value: number } for valid, { error: string } for invalid, null for blank
 */
export function validateIterations(input: string): { value: number } | { error: string } | null {
  const trimmed = input.trim();
  if (trimmed === '') return null; // blank is valid (omit from request)
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return { error: 'Must be a number' };
  if (!Number.isInteger(num)) return { error: 'Must be a whole number' };
  if (num <= 0) return { error: 'Must be a positive integer' };
  return { value: num };
}

export function validateMaxParallelTasks(input: string): { value: number } | { error: string } | null {
  const trimmed = input.trim();
  if (trimmed === '') return null; // blank is valid (omit from request; server will default)
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return { error: 'Must be a number' };
  if (!Number.isInteger(num)) return { error: 'Must be a whole number' };
  if (num < 1 || num > MAX_PARALLEL_TASKS) return { error: `Must be between 1 and ${MAX_PARALLEL_TASKS}` };
  return { value: num };
}

function extractTaskExecutionFromIssueJson(issueJson: Record<string, unknown> | null | undefined): { mode: TaskExecutionMode; maxParallelTasks: number } {
  if (!issueJson) return { mode: 'sequential', maxParallelTasks: 1 };
  const settings = issueJson.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { mode: 'sequential', maxParallelTasks: 1 };
  const taskExecution = (settings as Record<string, unknown>).taskExecution;
  if (!taskExecution || typeof taskExecution !== 'object' || Array.isArray(taskExecution)) return { mode: 'sequential', maxParallelTasks: 1 };
  const modeRaw = (taskExecution as Record<string, unknown>).mode;
  const maxRaw = (taskExecution as Record<string, unknown>).maxParallelTasks;
  const mode: TaskExecutionMode = modeRaw === 'parallel' ? 'parallel' : 'sequential';
  const maxParallelTasks = typeof maxRaw === 'number' && Number.isInteger(maxRaw) && maxRaw >= 1
    ? Math.min(maxRaw, MAX_PARALLEL_TASKS)
    : 1;
  return { mode, maxParallelTasks };
}

export function Sidebar() {
  const baseUrl = useViewerServerBaseUrl();
  const { pushToast } = useToast();
  const stream = useViewerStream();

  const issuesQuery = useIssuesQuery(baseUrl);
  const workflowQuery = useWorkflowQuery(baseUrl);

  const selectIssue = useSelectIssueMutation(baseUrl);
  const initIssue = useInitIssueMutation(baseUrl);
  const startRun = useStartRunMutation(baseUrl);
  const stopRun = useStopRunMutation(baseUrl);
  const setIssuePhase = useSetIssuePhaseMutation(baseUrl);
  const setTaskExecution = useSetTaskExecutionMutation(baseUrl);

  const run = stream.state?.run ?? null;
  const activeIssue = stream.state?.issue_ref ?? null;
  const issueJson = (stream.state?.issue_json ?? null) as Record<string, unknown> | null;
  const currentPhase = workflowQuery.data?.current_phase ?? null;
  const currentGroup = groupForPhase(currentPhase);

  const [provider, setProvider] = useState<Provider>(() => normalizeProvider(localStorage.getItem(PROVIDER_STORAGE_KEY)));
  const [iterationsInput, setIterationsInput] = useState<string>(() => localStorage.getItem(ITERATIONS_STORAGE_KEY) ?? '');

  const canonicalTaskExecution = extractTaskExecutionFromIssueJson(issueJson);
  const [taskExecutionMode, setTaskExecutionMode] = useState<TaskExecutionMode>(canonicalTaskExecution.mode);
  const [maxParallelTasksInput, setMaxParallelTasksInput] = useState<string>(String(canonicalTaskExecution.maxParallelTasks));

  useEffect(() => {
    setTaskExecutionMode(canonicalTaskExecution.mode);
    setMaxParallelTasksInput(String(canonicalTaskExecution.maxParallelTasks));
  }, [activeIssue, canonicalTaskExecution.mode, canonicalTaskExecution.maxParallelTasks]);

  // Validate iterations input
  const iterationsValidation = validateIterations(iterationsInput);
  const iterationsError = iterationsValidation !== null && 'error' in iterationsValidation ? iterationsValidation.error : null;
  const validIterations = iterationsValidation !== null && 'value' in iterationsValidation ? iterationsValidation.value : undefined;

  const maxParallelValidation = validateMaxParallelTasks(maxParallelTasksInput);
  const maxParallelError = maxParallelValidation !== null && 'error' in maxParallelValidation ? maxParallelValidation.error : null;
  const validMaxParallel = maxParallelValidation !== null && 'value' in maxParallelValidation ? maxParallelValidation.value : undefined;

  const issues = issuesQuery.data?.issues ?? [];
  const issueListEmpty = issuesQuery.isSuccess && issues.length === 0;

  const groupedPhaseButtons = useMemo(() => {
    return ['design', 'implement', 'review', 'complete'] as GroupPhase[];
  }, []);

  function handleSetProvider(next: Provider) {
    setProvider(next);
    try {
      localStorage.setItem(PROVIDER_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  function handleSetIterations(value: string) {
    setIterationsInput(value);
    const validation = validateIterations(value);
    try {
      if (validation !== null && 'value' in validation) {
        // Valid positive integer: store it
        localStorage.setItem(ITERATIONS_STORAGE_KEY, value.trim());
      } else if (value.trim() === '') {
        // Blank: remove from storage
        localStorage.removeItem(ITERATIONS_STORAGE_KEY);
      }
      // Invalid: don't update storage (keep last valid or absent)
    } catch {
      // ignore
    }
  }

  function handleSetMaxParallelTasks(value: string) {
    setMaxParallelTasksInput(value);
  }

  async function handleSaveTaskExecutionSettings() {
    const payload = {
      mode: taskExecutionMode,
      ...(validMaxParallel !== undefined ? { maxParallelTasks: validMaxParallel } : {}),
    };
    await setTaskExecution.mutateAsync(payload);
  }

  async function handleInitIssue(form: HTMLFormElement) {
    const fd = new FormData(form);
    const repo = String(fd.get('repo') ?? '').trim();
    const issue = Number(String(fd.get('issue') ?? '').trim());
    if (!repo || !Number.isInteger(issue) || issue <= 0) throw new Error('repo and issue are required');
    await initIssue.mutateAsync({ repo, issue });
  }

  async function handleSetGroupPhase(group: GroupPhase) {
    const workflow = workflowQuery.data ?? null;
    const phase = pickGroupTarget(workflow, group);
    if (!phase) throw new Error(`No phase found for group: ${group}`);
    await setIssuePhase.mutateAsync(phase);
  }

  return (
    <>
      <section className="card">
        <div className="cardTitle">Issue</div>
        <div className="cardBody">
          <div className="fieldRow">
            <button
              className="btn"
              onClick={() => void issuesQuery.refetch().catch((e) => pushToast(String(e)))}
              disabled={issuesQuery.isFetching}
            >
              {issuesQuery.isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div className="selectList">
            {issuesQuery.isLoading ? <div className="muted">Loading issues…</div> : null}
            {issuesQuery.isError ? <div className="errorBox">{issuesQuery.error instanceof Error ? issuesQuery.error.message : String(issuesQuery.error)}</div> : null}
            {issueListEmpty ? <div className="muted">No issues initialized yet.</div> : null}
            {issues.map((i) => {
              const ref = `${i.owner}/${i.repo}#${i.issue_number}`;
              const active = ref === activeIssue;
              return (
                <button
                  key={ref}
                  className={`listItem ${active ? 'active' : ''}`}
                  onClick={() => void selectIssue.mutateAsync(ref).catch((e) => pushToast(e instanceof Error ? e.message : String(e)))}
                  disabled={run?.running ?? false}
                  title={i.issue_title}
                >
                  <div className="listMain">{ref}</div>
                  <div className="listSub">{i.issue_title}</div>
                </button>
              );
            })}
          </div>

          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleInitIssue(e.currentTarget).catch((err: unknown) => pushToast(err instanceof Error ? err.message : String(err)));
            }}
          >
            <div className="muted" style={{ marginTop: 10 }}>
              Init issue
            </div>
            <label className="label">
              repo (owner/repo)
              <input name="repo" className="input" placeholder="hansjm10/jeeves" disabled={run?.running ?? false} />
            </label>
            <label className="label">
              issue number
              <input name="issue" className="input" placeholder="42" inputMode="numeric" disabled={run?.running ?? false} />
            </label>
            <button className="btn primary" type="submit" disabled={(run?.running ?? false) || initIssue.isPending}>
              {initIssue.isPending ? 'Initializing…' : 'Init + select'}
            </button>
          </form>
        </div>
      </section>

      <section className="card">
        <div className="cardTitle">Controls</div>
        <div className="cardBody">
          <div className="muted">Provider</div>
          <div className="segmented" style={{ marginBottom: 10 }}>
            {PROVIDERS.map((p) => (
              <button
                key={p}
                className={`segBtn ${provider === p ? 'active' : ''}`}
                onClick={() => handleSetProvider(p)}
                disabled={run?.running ?? false}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="muted">Iterations (optional)</div>
          <div className="fieldRow" style={{ marginBottom: 10 }}>
            <input
              className={`input ${iterationsError ? 'inputError' : ''}`}
              type="text"
              inputMode="numeric"
              placeholder="default: 10"
              value={iterationsInput}
              onChange={(e) => handleSetIterations(e.target.value)}
              disabled={run?.running ?? false}
              style={{ flex: 1 }}
            />
          </div>
          {iterationsError ? <div className="errorText" style={{ marginBottom: 10 }}>{iterationsError}</div> : null}

          <div className="muted">Task execution</div>
          <div className="segmented" style={{ marginBottom: 10 }}>
            {(['sequential', 'parallel'] as const).map((m) => (
              <button
                key={m}
                className={`segBtn ${taskExecutionMode === m ? 'active' : ''}`}
                onClick={() => setTaskExecutionMode(m)}
                disabled={!activeIssue || (run?.running ?? false) || setTaskExecution.isPending}
                title={m === 'parallel' ? 'Run independent tasks in parallel (implement/spec-check waves)' : 'Run tasks one-at-a-time'}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="muted">Max parallel tasks (1–8)</div>
          <div className="fieldRow" style={{ marginBottom: 10 }}>
            <input
              className={`input ${taskExecutionMode === 'parallel' && maxParallelError ? 'inputError' : ''}`}
              type="text"
              inputMode="numeric"
              placeholder="default: 1"
              value={maxParallelTasksInput}
              onChange={(e) => handleSetMaxParallelTasks(e.target.value)}
              disabled={!activeIssue || (run?.running ?? false) || setTaskExecution.isPending}
              style={{ flex: 1 }}
            />
            <button
              className="btn"
              onClick={() => void handleSaveTaskExecutionSettings().catch((e) => pushToast(e instanceof Error ? e.message : String(e)))}
              disabled={
                !activeIssue ||
                (run?.running ?? false) ||
                setTaskExecution.isPending ||
                (taskExecutionMode === 'parallel' && maxParallelError !== null)
              }
              title="Persist to issue.json.settings.taskExecution"
            >
              {setTaskExecution.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {taskExecutionMode === 'parallel' && maxParallelError ? <div className="errorText" style={{ marginBottom: 10 }}>{maxParallelError}</div> : null}
          <div className="muted" style={{ marginBottom: 10 }}>
            current: <span className="mono">{canonicalTaskExecution.mode}</span>
            {canonicalTaskExecution.mode === 'parallel' ? (
              <> × <span className="mono">{canonicalTaskExecution.maxParallelTasks}</span></>
            ) : null}
          </div>

          <div className="row">
            <button
              className="btn primary"
              onClick={() => void startRun.mutateAsync({ provider, max_iterations: validIterations }).catch((e) => pushToast(e instanceof Error ? e.message : String(e)))}
              disabled={!activeIssue || (run?.running ?? false) || startRun.isPending || iterationsError !== null}
            >
              {startRun.isPending ? 'Starting…' : 'Start'}
            </button>
            <button
              className="btn danger"
              onClick={() => void stopRun.mutateAsync({ force: false }).catch((e) => pushToast(e instanceof Error ? e.message : String(e)))}
              disabled={!(run?.running ?? false) || stopRun.isPending}
            >
              {stopRun.isPending ? 'Stopping…' : 'Stop'}
            </button>
          </div>
          <div className="muted" style={{ marginTop: 10 }}>
            Phase (grouped)
          </div>
          <div className="segmented">
            {groupedPhaseButtons.map((g) => (
              <button
                key={g}
                className={`segBtn ${currentGroup === g ? 'active' : ''}`}
                onClick={() => void handleSetGroupPhase(g).catch((e) => pushToast(e instanceof Error ? e.message : String(e)))}
                disabled={!activeIssue || (run?.running ?? false) || setIssuePhase.isPending}
              >
                {g}
              </button>
            ))}
          </div>
          <div className="muted" style={{ marginTop: 10 }}>
            current: <span className="mono">{currentPhase ?? '(unknown)'}</span>
          </div>
          {run ? (
            <div className="muted" style={{ marginTop: 10 }}>
              iterations: <span className="mono">{run.current_iteration}/{run.max_iterations}</span>
            </div>
          ) : null}
          {run?.last_error ? (
            <div className="errorBox" style={{ marginTop: 10 }}>
              {run.last_error}
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
