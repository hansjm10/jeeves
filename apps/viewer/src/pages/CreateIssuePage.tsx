import { useEffect, useMemo, useState } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { CreateIssueRequest, CreateIssueResponse, CreateIssueRunProvider } from '../api/types.js';
import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useCreateIssueMutation } from '../features/mutations.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';

const PROVIDERS = ['claude', 'codex', 'fake'] as const satisfies readonly CreateIssueRunProvider[];

function parseIssueNumber(issueUrl: string): number | null {
  try {
    const url = new URL(issueUrl);
    const m = url.pathname.match(/\/issues\/(\d+)(?:\/|$)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function CreateIssuePage() {
  const baseUrl = useViewerServerBaseUrl();
  const { pushToast } = useToast();
  const createIssue = useCreateIssueMutation(baseUrl);
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;

  const [repo, setRepo] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const [labels, setLabels] = useState('');
  const [assignees, setAssignees] = useState('');
  const [milestone, setMilestone] = useState('');

  const [init, setInit] = useState(true);
  const [autoSelect, setAutoSelect] = useState(true);
  const [autoRun, setAutoRun] = useState(false);
  const [provider, setProvider] = useState<CreateIssueRunProvider>('claude');

  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!runRunning) return;
    if (!init) return;
    // Create-only is allowed while a run is active, but init/select/run are not.
    setInit(false);
    setAutoSelect(false);
    setAutoRun(false);
  }, [init, runRunning]);

  const lastResponse: CreateIssueResponse | null = createIssue.data ?? null;
  const createdIssueUrl = lastResponse && lastResponse.ok ? lastResponse.issue_url : null;
  const createdIssueNumber = useMemo(() => (createdIssueUrl ? parseIssueNumber(createdIssueUrl) : null), [createdIssueUrl]);

  function validate(): string | null {
    if (!repo.trim()) return 'repo is required';
    if (!title.trim()) return 'title is required';
    if (!body.trim()) return 'body is required';
    if (runRunning && init) return 'Cannot init while Jeeves is running. Disable init or stop the run.';
    return null;
  }

  function parseCommaList(input: string): string[] | undefined {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    const values = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return values.length > 0 ? values : undefined;
  }

  async function handleSubmit() {
    setLocalError(null);
    const err = validate();
    if (err) {
      setLocalError(err);
      return;
    }

    const labelsList = parseCommaList(labels);
    const assigneesList = parseCommaList(assignees);
    const milestoneTrimmed = milestone.trim();
    const request: CreateIssueRequest = {
      repo: repo.trim(),
      title: title.trim(),
      body,
      ...(labelsList ? { labels: labelsList } : {}),
      ...(assigneesList ? { assignees: assigneesList } : {}),
      ...(milestoneTrimmed ? { milestone: milestoneTrimmed } : {}),
      ...(init
        ? {
            init: {},
            auto_select: autoSelect,
            ...(autoRun && autoSelect ? { auto_run: { provider } } : {}),
          }
        : {}),
    };

    await createIssue.mutateAsync(request);
  }

  return (
    <div className="panel">
      <div className="panelTitle">Create Issue</div>
      <div className="panelBody">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit().catch((e: unknown) => pushToast(e instanceof Error ? e.message : String(e)));
          }}
        >
          <label className="label">
            repo (owner/repo)
            <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="hansjm10/jeeves" />
          </label>
          <label className="label">
            title
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a new feature" />
          </label>
          <label className="label">
            body
            <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Describe the issue…" />
          </label>

          <div className="muted" style={{ marginTop: 10 }}>
            Preview
          </div>
          <div
            style={{
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              padding: 10,
              background: 'rgba(0,0,0,0.15)',
              overflowX: 'auto',
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
              {body.trim() ? body : '_Nothing to preview._'}
            </ReactMarkdown>
          </div>

          <div className="muted" style={{ marginTop: 10 }}>
            Options
          </div>

          <label className="label">
            labels (comma-separated)
            <input className="input" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, ui" />
          </label>

          <label className="label">
            assignees (comma-separated)
            <input className="input" value={assignees} onChange={(e) => setAssignees(e.target.value)} placeholder="octocat, hubot" />
          </label>

          <label className="label">
            milestone
            <input className="input" value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder="v1.0" />
          </label>

          <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={init}
              disabled={createIssue.isPending || runRunning}
              onChange={(e) => {
                const nextInit = e.target.checked;
                setInit(nextInit);
                if (!nextInit) {
                  setAutoSelect(false);
                  setAutoRun(false);
                }
              }}
            />
            init (create state + worktree)
          </label>

          {runRunning ? (
            <div className="muted" style={{ marginTop: 6 }}>
              A run is active: init/select/run options are disabled. You can still create an issue without init.
            </div>
          ) : null}

          <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={autoSelect}
              disabled={!init || createIssue.isPending || runRunning}
              onChange={(e) => {
                const nextAutoSelect = e.target.checked;
                setAutoSelect(nextAutoSelect);
                if (!nextAutoSelect) setAutoRun(false);
              }}
            />
            auto-select new issue
          </label>

          <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={autoRun}
              disabled={!init || !autoSelect || createIssue.isPending || runRunning}
              onChange={(e) => setAutoRun(e.target.checked)}
            />
            start-run after create
          </label>

          <div className="muted">Provider</div>
          <div className="segmented" style={{ marginBottom: 10 }}>
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                className={`segBtn ${provider === p ? 'active' : ''}`}
                onClick={() => setProvider(p)}
                disabled={!autoRun || !init || !autoSelect || createIssue.isPending || runRunning}
              >
                {p}
              </button>
            ))}
          </div>

          {localError ? <div className="errorBox">{localError}</div> : null}
          {createIssue.isError ? (
            <div className="errorBox">
              {createIssue.error instanceof Error ? createIssue.error.message : String(createIssue.error)}
            </div>
          ) : null}

          <button className="btn primary" type="submit" disabled={createIssue.isPending || (runRunning && init)}>
            {createIssue.isPending ? 'Creating…' : 'Create Issue'}
          </button>
        </form>

        {lastResponse && lastResponse.ok ? (
          <div style={{ marginTop: 16 }}>
            <div className="muted">Created</div>
            <div>
              URL:{' '}
              <a href={lastResponse.issue_url} target="_blank" rel="noreferrer" className="mono">
                {lastResponse.issue_url}
              </a>
            </div>
            <div className="mono">issue_ref: {lastResponse.issue_ref ?? '(unknown)'}</div>
            <div className="mono">number: {createdIssueNumber ?? '(unknown)'}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
