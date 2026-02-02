import { useEffect, useMemo, useState } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  expandIssue,
  buildExpandIssueRequestBody,
  getWorkflowDefaults,
} from "../api/client.js";
import type {
  CreateIssueRequest,
  CreateIssueResponse,
  CreateIssueRunProvider,
  IssueType,
  ExpandIssueRequest,
} from "../api/types.js";
import { useViewerServerBaseUrl } from "../app/ViewerServerProvider.js";
import { useCreateIssueMutation } from "../features/mutations.js";
import { useViewerStream } from "../stream/ViewerStreamProvider.js";
import { useToast } from "../ui/toast/ToastProvider.js";

const PROVIDERS = [
  "claude",
  "codex",
  "fake",
] as const satisfies readonly CreateIssueRunProvider[];
const ISSUE_TYPES: readonly IssueType[] = ["feature", "bug", "refactor"];

// Export for testing
export { buildExpandIssueRequestBody };

/**
 * State for undo functionality - stores previous title/body before applying expansion
 */
export type UndoState = Readonly<{
  title: string;
  body: string;
}> | null;

/**
 * Builds the expand request body from UI state.
 * Exported for testing purposes.
 */
export function buildExpandRequestFromState(
  summary: string,
  issueType: IssueType | undefined,
  expandProvider: string | undefined,
  expandModel: string | undefined,
): ExpandIssueRequest {
  const request: ExpandIssueRequest = { summary: summary.trim() };
  if (issueType !== undefined) {
    return { ...request, issue_type: issueType };
  }
  if (expandProvider !== undefined) {
    return { ...request, provider: expandProvider };
  }
  if (expandModel !== undefined) {
    return { ...request, model: expandModel };
  }
  return request;
}

/**
 * Applies expansion result to title/body fields, returning the new values and undo state.
 * Exported for testing purposes.
 */
export function applyExpansionResult(
  currentTitle: string,
  currentBody: string,
  generatedTitle: string,
  generatedBody: string,
): { newTitle: string; newBody: string; undoState: UndoState } {
  return {
    newTitle: generatedTitle,
    newBody: generatedBody,
    undoState: { title: currentTitle, body: currentBody },
  };
}

/**
 * Restores previous title/body from undo state.
 * Exported for testing purposes.
 */
export function restoreFromUndo(
  undoState: UndoState,
): { title: string; body: string } | null {
  if (!undoState) return null;
  return { title: undoState.title, body: undoState.body };
}

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

  const [repo, setRepo] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const [labels, setLabels] = useState("");
  const [assignees, setAssignees] = useState("");
  const [milestone, setMilestone] = useState("");

  const [init, setInit] = useState(true);
  const [autoSelect, setAutoSelect] = useState(true);
  const [autoRun, setAutoRun] = useState(false);
  const [provider, setProvider] = useState<CreateIssueRunProvider>("claude");

  const [localError, setLocalError] = useState<string | null>(null);

  // Expansion state
  const [summary, setSummary] = useState("");
  const [issueType, setIssueType] = useState<IssueType | undefined>(undefined);
  const [expandProvider, setExpandProvider] = useState<string>("");
  const [expandModel, setExpandModel] = useState<string>("");
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<UndoState>(null);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);

  // Load workflow defaults on mount
  useEffect(() => {
    let cancelled = false;
    void getWorkflowDefaults(baseUrl).then((defaults) => {
      if (cancelled) return;
      setExpandProvider(defaults.provider);
      if (defaults.model !== undefined) {
        setExpandModel(defaults.model);
      }
      setDefaultsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  useEffect(() => {
    if (!runRunning) return;
    if (!init) return;
    // Create-only is allowed while a run is active, but init/select/run are not.
    setInit(false);
    setAutoSelect(false);
    setAutoRun(false);
  }, [init, runRunning]);

  const lastResponse: CreateIssueResponse | null = createIssue.data ?? null;
  const createdIssueUrl =
    lastResponse && lastResponse.ok ? lastResponse.issue_url : null;
  const createdIssueNumber = useMemo(
    () => (createdIssueUrl ? parseIssueNumber(createdIssueUrl) : null),
    [createdIssueUrl],
  );

  function validate(): string | null {
    if (!repo.trim()) return "repo is required";
    if (!title.trim()) return "title is required";
    if (!body.trim()) return "body is required";
    if (runRunning && init)
      return "Cannot init while Jeeves is running. Disable init or stop the run.";
    return null;
  }

  function parseCommaList(input: string): string[] | undefined {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    const values = trimmed
      .split(",")
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

  async function handleExpand() {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      setExpandError("Summary is required for expansion");
      return;
    }
    if (trimmedSummary.length < 5) {
      setExpandError("Summary must be at least 5 characters");
      return;
    }
    if (trimmedSummary.length > 2000) {
      setExpandError("Summary must be at most 2000 characters");
      return;
    }

    setExpandError(null);
    setIsExpanding(true);

    try {
      const request: ExpandIssueRequest = { summary: trimmedSummary };
      if (issueType !== undefined) {
        (request as { issue_type?: IssueType }).issue_type = issueType;
      }
      if (expandProvider) {
        (request as { provider?: string }).provider = expandProvider;
      }
      if (expandModel && expandModel.trim()) {
        (request as { model?: string }).model = expandModel.trim();
      }

      const response = await expandIssue(baseUrl, request);

      if (!response.ok) {
        setExpandError(response.error);
        return;
      }

      // Apply the result using our helper (supports undo)
      const result = applyExpansionResult(
        title,
        body,
        response.title,
        response.body,
      );
      setTitle(result.newTitle);
      setBody(result.newBody);
      setUndoState(result.undoState);
    } catch (err) {
      setExpandError(err instanceof Error ? err.message : "Expansion failed");
    } finally {
      setIsExpanding(false);
    }
  }

  function handleUndo() {
    const restored = restoreFromUndo(undoState);
    if (restored) {
      setTitle(restored.title);
      setBody(restored.body);
      setUndoState(null);
    }
  }

  return (
    <div className="panel">
      <div className="panelTitle">Create Issue</div>
      <div className="panelBody">
        {/* AI Expansion Section */}
        <div
          style={{
            marginBottom: 20,
            padding: 12,
            background: "rgba(255,255,255,0.03)",
            borderRadius: 6,
          }}
        >
          <div className="muted" style={{ marginBottom: 8, fontWeight: 500 }}>
            AI Draft Generation
          </div>

          <label className="label">
            summary (brief description)
            <textarea
              className="textarea"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Describe what you want to accomplish..."
              rows={2}
            />
          </label>

          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <label className="label" style={{ flex: 1 }}>
              issue type
              <select
                className="input"
                value={issueType ?? ""}
                onChange={(e) =>
                  setIssueType(
                    e.target.value ? (e.target.value as IssueType) : undefined,
                  )
                }
              >
                <option value="">Select type...</option>
                {ISSUE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label className="label" style={{ flex: 1 }}>
              provider{defaultsLoaded ? "" : " (loading...)"}
              <select
                className="input"
                value={expandProvider}
                onChange={(e) => setExpandProvider(e.target.value)}
              >
                {/* Include current value in options if it's not in PROVIDERS (e.g., from workflow defaults) */}
                {expandProvider &&
                !PROVIDERS.includes(
                  expandProvider as CreateIssueRunProvider,
                ) ? (
                  <option key={expandProvider} value={expandProvider}>
                    {expandProvider}
                  </option>
                ) : null}
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label className="label" style={{ flex: 1 }}>
              model (optional)
              <input
                className="input"
                value={expandModel}
                onChange={(e) => setExpandModel(e.target.value)}
                placeholder="default"
              />
            </label>
          </div>

          {expandError ? (
            <div className="errorBox" style={{ marginTop: 8 }}>
              {expandError}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="btn"
              type="button"
              onClick={() => void handleExpand()}
              disabled={isExpanding || !summary.trim()}
            >
              {isExpanding ? "Expanding..." : "Expand"}
            </button>

            {undoState ? (
              <button className="btn" type="button" onClick={handleUndo}>
                Undo
              </button>
            ) : null}
          </div>
        </div>

        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit().catch((e: unknown) =>
              pushToast(e instanceof Error ? e.message : String(e)),
            );
          }}
        >
          <label className="label">
            repo (owner/repo)
            <input
              className="input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="hansjm10/jeeves"
            />
          </label>
          <label className="label">
            title
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a new feature"
            />
          </label>
          <label className="label">
            body
            <textarea
              className="textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Describe the issue…"
            />
          </label>

          <div className="muted" style={{ marginTop: 10 }}>
            Preview
          </div>
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              padding: 10,
              background: "rgba(0,0,0,0.15)",
              overflowX: "auto",
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
              {body.trim() ? body : "_Nothing to preview._"}
            </ReactMarkdown>
          </div>

          <div className="muted" style={{ marginTop: 10 }}>
            Options
          </div>

          <label className="label">
            labels (comma-separated)
            <input
              className="input"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="bug, ui"
            />
          </label>

          <label className="label">
            assignees (comma-separated)
            <input
              className="input"
              value={assignees}
              onChange={(e) => setAssignees(e.target.value)}
              placeholder="octocat, hubot"
            />
          </label>

          <label className="label">
            milestone
            <input
              className="input"
              value={milestone}
              onChange={(e) => setMilestone(e.target.value)}
              placeholder="v1.0"
            />
          </label>

          <label
            className="label"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
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
              A run is active: init/select/run options are disabled. You can
              still create an issue without init.
            </div>
          ) : null}

          <label
            className="label"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
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

          <label
            className="label"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <input
              type="checkbox"
              checked={autoRun}
              disabled={
                !init || !autoSelect || createIssue.isPending || runRunning
              }
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
                className={`segBtn ${provider === p ? "active" : ""}`}
                onClick={() => setProvider(p)}
                disabled={
                  !autoRun ||
                  !init ||
                  !autoSelect ||
                  createIssue.isPending ||
                  runRunning
                }
              >
                {p}
              </button>
            ))}
          </div>

          {localError ? <div className="errorBox">{localError}</div> : null}
          {createIssue.isError ? (
            <div className="errorBox">
              {createIssue.error instanceof Error
                ? createIssue.error.message
                : String(createIssue.error)}
            </div>
          ) : null}

          <button
            className="btn primary"
            type="submit"
            disabled={createIssue.isPending || (runRunning && init)}
          >
            {createIssue.isPending ? "Creating…" : "Create Issue"}
          </button>
        </form>

        {lastResponse && lastResponse.ok ? (
          <div style={{ marginTop: 16 }}>
            <div className="muted">Created</div>
            <div>
              URL:{" "}
              <a
                href={lastResponse.issue_url}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {lastResponse.issue_url}
              </a>
            </div>
            <div className="mono">
              issue_ref: {lastResponse.issue_ref ?? "(unknown)"}
            </div>
            <div className="mono">
              number: {createdIssueNumber ?? "(unknown)"}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
