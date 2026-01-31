import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

type IssueListItem = Readonly<{
  owner: string;
  repo: string;
  issue_number: number;
  issue_title: string;
  branch: string | null;
  phase: string | null;
  state_dir: string;
}>;

type IssueListResponse = Readonly<{
  ok: boolean;
  issues: IssueListItem[];
  current_issue: string | null;
}>;

type WorkflowPhase = Readonly<{
  id: string;
  name: string;
  type: string;
  description: string;
}>;

type WorkflowResponse = Readonly<{
  ok: boolean;
  workflow_name: string;
  start_phase: string;
  current_phase: string;
  phases: WorkflowPhase[];
  phase_order: string[];
}>;

type RunStatus = Readonly<{
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
}>;

type StateSnapshot = Readonly<{
  issue_ref: string | null;
  issue_json: Record<string, unknown> | null;
  run: RunStatus;
}>;

type PromptListResponse = Readonly<{ ok: boolean; prompts: { id: string }[]; count: number }>;
type PromptGetResponse = Readonly<{ ok: boolean; id: string; content: string }>;

type LogEvent = Readonly<{ lines: string[]; reset?: boolean }>;

type ViewTab = 'logs' | 'viewer-logs' | 'prompts' | 'sdk';

type GroupPhase = 'design' | 'implement' | 'review' | 'complete';

type Model = Readonly<{
  connected: boolean;
  lastError: string | null;
  state: StateSnapshot | null;
  logs: string[];
  viewerLogs: string[];
  sdkEvents: { event: string; data: unknown }[];
}>;

type Action =
  | { type: 'ws_connected' }
  | { type: 'ws_disconnected'; error?: string }
  | { type: 'state'; data: StateSnapshot }
  | { type: 'logs'; data: LogEvent }
  | { type: 'viewer-logs'; data: LogEvent }
  | { type: 'sdk'; event: string; data: unknown };

const MAX_LOG_LINES = 10_000;
const MAX_SDK_EVENTS = 500;

function capArray<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

function reducer(state: Model, action: Action): Model {
  switch (action.type) {
    case 'ws_connected':
      return { ...state, connected: true, lastError: null };
    case 'ws_disconnected':
      return { ...state, connected: false, lastError: action.error ?? state.lastError };
    case 'state':
      return { ...state, state: action.data };
    case 'logs': {
      const next = action.data.reset ? action.data.lines : [...state.logs, ...action.data.lines];
      return { ...state, logs: capArray(next, MAX_LOG_LINES) };
    }
    case 'viewer-logs': {
      const next = action.data.reset ? action.data.lines : [...state.viewerLogs, ...action.data.lines];
      return { ...state, viewerLogs: capArray(next, MAX_LOG_LINES) };
    }
    case 'sdk': {
      const next = [...state.sdkEvents, { event: action.event, data: action.data }];
      return { ...state, sdkEvents: capArray(next, MAX_SDK_EVENTS) };
    }
    default:
      return state;
  }
}

async function apiJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.method && init.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

function encodePathPreservingSlashes(pathLike: string): string {
  return pathLike
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function groupForPhase(phaseId: string | null): GroupPhase {
  const p = (phaseId ?? '').trim();
  if (!p) return 'design';
  if (p === 'complete') return 'complete';
  if (p.startsWith('design_')) return 'design';
  if (p === 'prepare_pr' || p.startsWith('code_') || p.includes('review')) return 'review';
  return 'implement';
}

function pickGroupTarget(workflow: WorkflowResponse | null, group: GroupPhase): string | null {
  if (!workflow?.ok) return null;
  const phaseTypes = new Map(workflow.phases.map((p) => [p.id, p.type] as const));
  const order = workflow.phase_order;

  const isDesign = (p: string) => p.startsWith('design_');
  const isTerminal = (p: string) => phaseTypes.get(p) === 'terminal' || p === 'complete';
  const isReview = (p: string) => p === 'prepare_pr' || p.startsWith('code_') || p.includes('review');

  if (group === 'design') return order.find(isDesign) ?? workflow.start_phase ?? null;
  if (group === 'review') return order.find(isReview) ?? null;
  if (group === 'complete') return order.find(isTerminal) ?? null;
  // implement
  return order.find((p) => !isDesign(p) && !isReview(p) && !isTerminal(p)) ?? null;
}

export function App() {
  const baseUrl = useMemo(() => {
    const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_VIEWER_SERVER_URL;
    return (raw ?? window.location.origin).trim();
  }, []);

  const [model, dispatch] = useReducer(reducer, {
    connected: false,
    lastError: null,
    state: null,
    logs: [],
    viewerLogs: [],
    sdkEvents: [],
  });

  const [tab, setTab] = useState<ViewTab>('logs');
  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowResponse | null>(null);
  const [promptList, setPromptList] = useState<string[]>([]);
  const [promptId, setPromptId] = useState<string | null>(null);
  const [promptContent, setPromptContent] = useState<string>('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 3500);
  }

  async function refreshIssues() {
    const res = await apiJson<IssueListResponse>(baseUrl, '/api/issues');
    setIssues(res.issues ?? []);
  }

  async function refreshWorkflow() {
    const res = await apiJson<WorkflowResponse>(baseUrl, '/api/workflow');
    setWorkflow(res);
  }

  async function refreshPrompts() {
    const res = await apiJson<PromptListResponse>(baseUrl, '/api/prompts');
    setPromptList(res.prompts.map((p) => p.id));
  }

  async function loadPrompt(id: string) {
    const res = await apiJson<PromptGetResponse>(baseUrl, `/api/prompts/${encodePathPreservingSlashes(id)}`);
    setPromptId(res.id);
    setPromptContent(res.content);
    setPromptDirty(false);
  }

  async function savePrompt() {
    if (!promptId) return;
    await apiJson(baseUrl, `/api/prompts/${encodePathPreservingSlashes(promptId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content: promptContent }),
    });
    setPromptDirty(false);
    showToast(`Saved ${promptId}`);
  }

  async function selectIssue(issueRef: string) {
    await apiJson(baseUrl, '/api/issues/select', { method: 'POST', body: JSON.stringify({ issue_ref: issueRef }) });
    await refreshIssues();
    await refreshWorkflow();
  }

  async function initIssue(form: HTMLFormElement) {
    const fd = new FormData(form);
    const repo = String(fd.get('repo') ?? '').trim();
    const issue = Number(String(fd.get('issue') ?? '').trim());
    if (!repo || !Number.isInteger(issue) || issue <= 0) throw new Error('repo and issue are required');
    await apiJson(baseUrl, '/api/init/issue', {
      method: 'POST',
      body: JSON.stringify({ repo, issue }),
    });
    await refreshIssues();
    await refreshWorkflow();
  }

  async function startRun() {
    await apiJson(baseUrl, '/api/run', { method: 'POST', body: JSON.stringify({}) });
  }

  async function stopRun() {
    await apiJson(baseUrl, '/api/run/stop', { method: 'POST', body: JSON.stringify({ force: false }) });
  }

  async function setGroupPhase(group: GroupPhase) {
    const phase = pickGroupTarget(workflow, group);
    if (!phase) throw new Error(`No phase found for group: ${group}`);
    await apiJson(baseUrl, '/api/issue/status', { method: 'POST', body: JSON.stringify({ phase }) });
    await refreshWorkflow();
  }

  useEffect(() => {
    void refreshIssues().catch((e: unknown) => dispatch({ type: 'ws_disconnected', error: e instanceof Error ? e.message : String(e) }));
    void refreshWorkflow().catch(() => void 0);
    void refreshPrompts().catch(() => void 0);
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: number | null = null;

    function connect() {
      if (cancelled) return;
      const wsUrl = new URL('/api/ws', baseUrl);
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

      const ws = new WebSocket(wsUrl.toString());
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        dispatch({ type: 'ws_connected' });
      });

      ws.addEventListener('message', (evt) => {
        try {
          const parsed = JSON.parse(String(evt.data)) as { event?: unknown; data?: unknown };
          const event = typeof parsed.event === 'string' ? parsed.event : null;
          if (!event) return;
          if (event === 'state') dispatch({ type: 'state', data: parsed.data as StateSnapshot });
          else if (event === 'logs') dispatch({ type: 'logs', data: parsed.data as LogEvent });
          else if (event === 'viewer-logs') dispatch({ type: 'viewer-logs', data: parsed.data as LogEvent });
          else dispatch({ type: 'sdk', event, data: parsed.data });
        } catch {
          // ignore
        }
      });

      ws.addEventListener('close', () => {
        dispatch({ type: 'ws_disconnected', error: 'WebSocket disconnected' });
        if (cancelled) return;
        reconnectTimer = window.setTimeout(connect, 600);
      });

      ws.addEventListener('error', () => {
        dispatch({ type: 'ws_disconnected', error: 'WebSocket error' });
      });
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [baseUrl]);

  const run = model.state?.run ?? null;
  const activeIssue = model.state?.issue_ref ?? null;
  const currentPhase = workflow?.current_phase ?? null;
  const currentGroup = groupForPhase(currentPhase);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="logo">J</div>
          <div>
            <div className="title">Jeeves Viewer</div>
            <div className="subtitle">{baseUrl}</div>
          </div>
        </div>
        <div className="status">
          <div className={`pill ${model.connected ? 'ok' : 'bad'}`}>{model.connected ? 'connected' : 'disconnected'}</div>
          <div className={`pill ${run?.running ? 'ok' : 'idle'}`}>{run?.running ? 'running' : 'idle'}</div>
        </div>
      </header>

      <main className="layout">
        <aside className="sidebar">
          <section className="card">
            <div className="cardTitle">Issue</div>
            <div className="cardBody">
              <div className="fieldRow">
                <button className="btn" onClick={() => void refreshIssues().catch((e) => showToast(String(e)))}>
                  Refresh
                </button>
              </div>
              <div className="selectList">
                {issues.length === 0 ? (
                  <div className="muted">No issues initialized yet.</div>
                ) : (
                  issues.map((i) => {
                    const ref = `${i.owner}/${i.repo}#${i.issue_number}`;
                    const active = ref === activeIssue;
                    return (
                      <button
                        key={ref}
                        className={`listItem ${active ? 'active' : ''}`}
                        onClick={() => void selectIssue(ref).catch((e) => showToast(String(e)))}
                        disabled={run?.running ?? false}
                        title={i.issue_title}
                      >
                        <div className="listMain">{ref}</div>
                        <div className="listSub">{i.issue_title}</div>
                      </button>
                    );
                  })
                )}
              </div>

              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void initIssue(e.currentTarget).catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
                }}
              >
                <div className="muted" style={{ marginTop: 10 }}>
                  Init issue
                </div>
                <label className="label">
                  repo (owner/repo)
                  <input name="repo" className="input" placeholder="hansjm10/jeeves" />
                </label>
                <label className="label">
                  issue number
                  <input name="issue" className="input" placeholder="42" inputMode="numeric" />
                </label>
                <button className="btn primary" type="submit" disabled={run?.running ?? false}>
                  Init + select
                </button>
              </form>
            </div>
          </section>

          <section className="card">
            <div className="cardTitle">Controls</div>
            <div className="cardBody">
              <div className="row">
                <button
                  className="btn primary"
                  onClick={() => void startRun().catch((e) => showToast(String(e)))}
                  disabled={!activeIssue || (run?.running ?? false)}
                >
                  Start
                </button>
                <button
                  className="btn danger"
                  onClick={() => void stopRun().catch((e) => showToast(String(e)))}
                  disabled={!(run?.running ?? false)}
                >
                  Stop
                </button>
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                Phase (grouped)
              </div>
              <div className="segmented">
                {(['design', 'implement', 'review', 'complete'] as GroupPhase[]).map((g) => (
                  <button
                    key={g}
                    className={`segBtn ${currentGroup === g ? 'active' : ''}`}
                    onClick={() => void setGroupPhase(g).catch((e) => showToast(String(e)))}
                    disabled={!activeIssue || (run?.running ?? false)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                current: <span className="mono">{currentPhase ?? '(unknown)'}</span>
              </div>
              {run?.last_error ? (
                <div className="errorBox" style={{ marginTop: 10 }}>
                  {run.last_error}
                </div>
              ) : null}
            </div>
          </section>
        </aside>

        <section className="main">
          <div className="tabs">
            {(['logs', 'viewer-logs', 'prompts', 'sdk'] as ViewTab[]).map((t) => (
              <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>

          {tab === 'logs' ? <LogPanel title="Live logs" lines={model.logs} /> : null}
          {tab === 'viewer-logs' ? <LogPanel title="Viewer logs" lines={model.viewerLogs} /> : null}

          {tab === 'sdk' ? (
            <div className="panel">
              <div className="panelTitle">SDK events</div>
              <div className="panelBody">
                <div className="muted">showing last {model.sdkEvents.length} events</div>
                <pre className="log">
                  {model.sdkEvents
                    .map((e) => JSON.stringify(e, null, 2))
                    .join('\n')}
                </pre>
              </div>
            </div>
          ) : null}

          {tab === 'prompts' ? (
            <div className="panel">
              <div className="panelTitle">Prompts</div>
              <div className="panelBody prompts">
                <div className="promptList">
                  <div className="row">
                    <button className="btn" onClick={() => void refreshPrompts().catch((e) => showToast(String(e)))}>
                      Refresh
                    </button>
                  </div>
                  {promptList.map((id) => (
                    <button
                      key={id}
                      className={`listItem ${promptId === id ? 'active' : ''}`}
                      onClick={() => {
                        if (promptDirty && !window.confirm('Discard unsaved changes?')) return;
                        void loadPrompt(id).catch((e) => showToast(String(e)));
                      }}
                    >
                      <div className="listMain mono">{id}</div>
                    </button>
                  ))}
                </div>
                <div className="promptEditor">
                  <div className="row">
                    <div className="muted">{promptId ? <span className="mono">{promptId}</span> : 'Select a prompt'}</div>
                    <div className="row">
                      <button className="btn" disabled={!promptId} onClick={() => void (promptId ? loadPrompt(promptId) : Promise.resolve()).catch((e) => showToast(String(e)))}>
                        Reload
                      </button>
                      <button
                        className="btn primary"
                        disabled={!promptId || !promptDirty || (run?.running ?? false)}
                        onClick={() => void savePrompt().catch((e) => showToast(String(e)))}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="textarea"
                    value={promptContent}
                    onChange={(e) => {
                      setPromptContent(e.target.value);
                      setPromptDirty(true);
                    }}
                    spellCheck={false}
                    disabled={!promptId}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </main>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function LogPanel(props: { title: string; lines: string[] }) {
  return (
    <div className="panel">
      <div className="panelTitle">{props.title}</div>
      <div className="panelBody">
        <div className="muted">lines: {props.lines.length}</div>
        <pre className="log">{props.lines.join('\n')}</pre>
      </div>
    </div>
  );
}
