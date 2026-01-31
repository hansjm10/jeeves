import { useMemo, useState } from 'react';

import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useInitIssueMutation, useSelectIssueMutation, useSetIssuePhaseMutation, useStartRunMutation, useStopRunMutation } from '../features/mutations.js';
import { useIssuesQuery } from '../features/issues/queries.js';
import { groupForPhase, pickGroupTarget, type GroupPhase } from '../features/workflow/phaseGroups.js';
import { useWorkflowQuery } from '../features/workflow/queries.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';

const PROVIDERS = ['claude', 'codex', 'fake'] as const;
type Provider = (typeof PROVIDERS)[number];
const PROVIDER_STORAGE_KEY = 'jeeves.provider';

function normalizeProvider(value: unknown): Provider {
  if (value === 'claude' || value === 'codex' || value === 'fake') return value;
  return 'claude';
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

  const run = stream.state?.run ?? null;
  const activeIssue = stream.state?.issue_ref ?? null;
  const currentPhase = workflowQuery.data?.current_phase ?? null;
  const currentGroup = groupForPhase(currentPhase);

  const [provider, setProvider] = useState<Provider>(() => normalizeProvider(localStorage.getItem(PROVIDER_STORAGE_KEY)));

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
          <div className="row">
            <button
              className="btn primary"
              onClick={() => void startRun.mutateAsync({ provider }).catch((e) => pushToast(e instanceof Error ? e.message : String(e)))}
              disabled={!activeIssue || (run?.running ?? false) || startRun.isPending}
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
