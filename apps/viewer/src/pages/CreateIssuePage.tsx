import { useMemo, useState } from 'react';

import type { CreateIssueResponse, CreateIssueRunProvider } from '../api/types.js';
import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useCreateIssueMutation } from '../features/mutations.js';
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

  const [repo, setRepo] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const [init, setInit] = useState(true);
  const [autoSelect, setAutoSelect] = useState(true);
  const [autoRun, setAutoRun] = useState(false);
  const [provider, setProvider] = useState<CreateIssueRunProvider>('claude');

  const [localError, setLocalError] = useState<string | null>(null);

  const lastResponse: CreateIssueResponse | null = createIssue.data ?? null;
  const createdIssueUrl = lastResponse && lastResponse.ok ? lastResponse.issue_url : null;
  const createdIssueNumber = useMemo(() => (createdIssueUrl ? parseIssueNumber(createdIssueUrl) : null), [createdIssueUrl]);

  function validate(): string | null {
    if (!repo.trim()) return 'repo is required';
    if (!title.trim()) return 'title is required';
    if (!body.trim()) return 'body is required';
    return null;
  }

  async function handleSubmit() {
    setLocalError(null);
    const err = validate();
    if (err) {
      setLocalError(err);
      return;
    }

    const requestInit = init;
    const requestAutoSelect = requestInit ? autoSelect : false;
    const requestAutoRun = requestAutoSelect ? autoRun : false;

    await createIssue.mutateAsync({
      repo: repo.trim(),
      title: title.trim(),
      body,
      init: requestInit,
      auto_select: requestAutoSelect,
      auto_run: requestAutoRun,
      ...(requestAutoRun ? { provider } : {}),
    });
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
            Options
          </div>

          <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={init}
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

          <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={autoSelect}
              disabled={!init}
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
              disabled={!init || !autoSelect}
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
                disabled={!autoRun || !init || !autoSelect}
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

          <button className="btn primary" type="submit" disabled={createIssue.isPending}>
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
