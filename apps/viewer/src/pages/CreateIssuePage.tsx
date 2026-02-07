import { useEffect, useState } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  expandIssue,
  buildExpandIssueRequestBody,
  getWorkflowDefaults,
} from '../api/client.js';
import type {
  CreateIssueRunProvider,
  IssueType,
  ExpandIssueRequest,
} from '../api/types.js';
import type {
  IssueProvider,
  AzureWorkItemType,
  CreateProviderIssueRequest,
  InitFromExistingRequest,
  IngestResponse,
  IngestHierarchy,
  HierarchyItemRef,
} from '../api/azureDevopsTypes.js';
import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { ApiValidationError } from '../features/azureDevops/api.js';
import {
  useCreateProviderIssueMutation,
  useInitFromExistingMutation,
} from '../features/providerIngest/queries.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';

const RUN_PROVIDERS = [
  'claude',
  'codex',
  'fake',
] as const satisfies readonly CreateIssueRunProvider[];
const ISSUE_TYPES: readonly IssueType[] = ['feature', 'bug', 'refactor'];
const ISSUE_PROVIDERS: readonly IssueProvider[] = ['github', 'azure_devops'];
const AZURE_WORK_ITEM_TYPES: readonly AzureWorkItemType[] = ['User Story', 'Bug', 'Task'];

/** Modes for the create/init form */
type FormMode = 'create' | 'init_existing';

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

/**
 * Builds a CreateProviderIssueRequest from form state.
 * Exported for testing purposes.
 */
export function buildCreateProviderRequest(
  issueProvider: IssueProvider,
  repo: string,
  title: string,
  body: string,
  options: {
    labels?: string;
    assignees?: string;
    milestone?: string;
    azureWorkItemType?: AzureWorkItemType;
    azureAreaPath?: string;
    azureIterationPath?: string;
    azureTags?: string;
    azureParentId?: string;
    azureOrganization?: string;
    azureProject?: string;
    init: boolean;
    autoSelect: boolean;
    autoRun: boolean;
    runProvider: CreateIssueRunProvider;
  },
): CreateProviderIssueRequest {
  const labelsList = parseCommaList(options.labels ?? '');
  const assigneesList = parseCommaList(options.assignees ?? '');
  const milestoneTrimmed = options.milestone?.trim();
  const azureTagsList = parseCommaList(options.azureTags ?? '');

  const request: CreateProviderIssueRequest = {
    provider: issueProvider,
    repo: repo.trim(),
    title: title.trim(),
    body,
    ...(labelsList ? { labels: labelsList } : {}),
    ...(assigneesList ? { assignees: assigneesList } : {}),
    ...(milestoneTrimmed ? { milestone: milestoneTrimmed } : {}),
    ...(issueProvider === 'azure_devops' ? {
      azure: {
        ...(options.azureWorkItemType ? { work_item_type: options.azureWorkItemType } : {}),
        ...(options.azureAreaPath?.trim() ? { area_path: options.azureAreaPath.trim() } : {}),
        ...(options.azureIterationPath?.trim() ? { iteration_path: options.azureIterationPath.trim() } : {}),
        ...(azureTagsList ? { tags: azureTagsList } : {}),
        ...(options.azureParentId?.trim() ? { parent_id: Number(options.azureParentId.trim()) } : {}),
        ...(options.azureOrganization?.trim() ? { organization: options.azureOrganization.trim() } : {}),
        ...(options.azureProject?.trim() ? { project: options.azureProject.trim() } : {}),
      },
    } : {}),
    ...(options.init ? {
      init: {},
      auto_select: options.autoSelect,
      ...(options.autoRun && options.autoSelect ? { auto_run: { provider: options.runProvider } } : {}),
    } : {}),
  };

  return request;
}

/**
 * Builds an InitFromExistingRequest from form state.
 * Exported for testing purposes.
 */
export function buildInitFromExistingRequest(
  issueProvider: IssueProvider,
  repo: string,
  existingRef: string,
  options: {
    azureOrganization?: string;
    azureProject?: string;
    azureFetchHierarchy?: boolean;
    init: boolean;
    autoSelect: boolean;
    autoRun: boolean;
    runProvider: CreateIssueRunProvider;
  },
): InitFromExistingRequest {
  // Determine if ref is a URL or an ID
  const trimmedRef = existingRef.trim();
  const isUrl = trimmedRef.startsWith('http://') || trimmedRef.startsWith('https://');
  const existing = isUrl
    ? { url: trimmedRef }
    : { id: /^\d+$/.test(trimmedRef) ? Number(trimmedRef) : trimmedRef };

  const request: InitFromExistingRequest = {
    provider: issueProvider,
    repo: repo.trim(),
    existing,
    ...(issueProvider === 'azure_devops' ? {
      azure: {
        ...(options.azureOrganization?.trim() ? { organization: options.azureOrganization.trim() } : {}),
        ...(options.azureProject?.trim() ? { project: options.azureProject.trim() } : {}),
        ...(options.azureFetchHierarchy !== undefined ? { fetch_hierarchy: options.azureFetchHierarchy } : {}),
      },
    } : {}),
    ...(options.init ? {
      init: {},
      auto_select: options.autoSelect,
      ...(options.autoRun && options.autoSelect ? { auto_run: { provider: options.runProvider } } : {}),
    } : {}),
  };

  return request;
}

/**
 * Formats hierarchy data for display.
 * Exported for testing purposes.
 */
export function formatHierarchySummary(hierarchy: IngestHierarchy | undefined): string | null {
  if (!hierarchy) return null;
  const parts: string[] = [];
  if (hierarchy.parent) {
    parts.push(`Parent: ${hierarchy.parent.title} (#${hierarchy.parent.id})`);
  }
  if (hierarchy.children.length > 0) {
    const childList = hierarchy.children.map((c: HierarchyItemRef) => `${c.title} (#${c.id})`).join(', ');
    parts.push(`Children: ${childList}`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

/**
 * Parse field_errors from an ApiValidationError into a form-field-indexed structure.
 * Exported for testing purposes.
 */
export function parseIngestFieldErrors(err: unknown): Record<string, string> | null {
  if (err instanceof ApiValidationError) {
    return err.fieldErrors;
  }
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

export function CreateIssuePage() {
  const baseUrl = useViewerServerBaseUrl();
  const { pushToast } = useToast();
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;

  // Provider and mode
  const [issueProvider, setIssueProvider] = useState<IssueProvider>('github');
  const [formMode, setFormMode] = useState<FormMode>('create');

  // Common fields
  const [repo, setRepo] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  // GitHub-specific fields
  const [labels, setLabels] = useState('');
  const [assignees, setAssignees] = useState('');
  const [milestone, setMilestone] = useState('');

  // Azure-specific fields
  const [azureWorkItemType, setAzureWorkItemType] = useState<AzureWorkItemType | ''>('');
  const [azureAreaPath, setAzureAreaPath] = useState('');
  const [azureIterationPath, setAzureIterationPath] = useState('');
  const [azureTags, setAzureTags] = useState('');
  const [azureParentId, setAzureParentId] = useState('');
  const [azureOrganization, setAzureOrganization] = useState('');
  const [azureProject, setAzureProject] = useState('');
  const [azureFetchHierarchy, setAzureFetchHierarchy] = useState(false);

  // Init-from-existing
  const [existingRef, setExistingRef] = useState('');

  // Init/run options
  const [init, setInit] = useState(true);
  const [autoSelect, setAutoSelect] = useState(true);
  const [autoRun, setAutoRun] = useState(false);
  const [runProvider, setRunProvider] = useState<CreateIssueRunProvider>('claude');

  // Error state
  const [localError, setLocalError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Result state
  const [lastIngestResponse, setLastIngestResponse] = useState<IngestResponse | null>(null);

  // Expansion state
  const [summary, setSummary] = useState('');
  const [issueType, setIssueType] = useState<IssueType | undefined>(undefined);
  const [expandProvider, setExpandProvider] = useState<string>('');
  const [expandModel, setExpandModel] = useState<string>('');
  const [isExpanding, setIsExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<UndoState>(null);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);

  // Mutations
  const createMutation = useCreateProviderIssueMutation(baseUrl);
  const initFromExistingMutation = useInitFromExistingMutation(baseUrl);
  const isSubmitting = createMutation.isPending || initFromExistingMutation.isPending;

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
    setInit(false);
    setAutoSelect(false);
    setAutoRun(false);
  }, [init, runRunning]);

  // Clear result when form mode or provider changes
  useEffect(() => {
    setLastIngestResponse(null);
    setFieldErrors({});
    setLocalError(null);
  }, [issueProvider, formMode]);

  function validate(): string | null {
    if (!repo.trim()) return 'repo is required';
    if (formMode === 'create') {
      if (!title.trim()) return 'title is required';
      if (!body.trim()) return 'body is required';
    } else {
      if (!existingRef.trim()) return 'issue ID or URL is required';
    }
    if (runRunning && init)
      return 'Cannot init while Jeeves is running. Disable init or stop the run.';
    return null;
  }

  async function handleSubmit() {
    setLocalError(null);
    setFieldErrors({});
    const err = validate();
    if (err) {
      setLocalError(err);
      return;
    }

    try {
      let response: IngestResponse;

      if (formMode === 'create') {
        const request = buildCreateProviderRequest(
          issueProvider,
          repo,
          title,
          body,
          {
            labels,
            assignees,
            milestone,
            azureWorkItemType: azureWorkItemType || undefined,
            azureAreaPath,
            azureIterationPath,
            azureTags,
            azureParentId,
            azureOrganization,
            azureProject,
            init,
            autoSelect,
            autoRun,
            runProvider,
          },
        );
        response = await createMutation.mutateAsync(request);
      } else {
        const request = buildInitFromExistingRequest(
          issueProvider,
          repo,
          existingRef,
          {
            azureOrganization,
            azureProject,
            azureFetchHierarchy: azureFetchHierarchy,
            init,
            autoSelect,
            autoRun,
            runProvider,
          },
        );
        response = await initFromExistingMutation.mutateAsync(request);
      }

      setLastIngestResponse(response);

      if (response.warnings.length > 0) {
        pushToast(`Completed with warnings: ${response.warnings.join(', ')}`);
      }
    } catch (submitErr) {
      const parsedFieldErrors = parseIngestFieldErrors(submitErr);
      if (parsedFieldErrors) {
        setFieldErrors(parsedFieldErrors);
      }
      pushToast(submitErr instanceof Error ? submitErr.message : String(submitErr));
    }
  }

  async function handleExpand() {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      setExpandError('Summary is required for expansion');
      return;
    }
    if (trimmedSummary.length < 5) {
      setExpandError('Summary must be at least 5 characters');
      return;
    }
    if (trimmedSummary.length > 2000) {
      setExpandError('Summary must be at most 2000 characters');
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
      setExpandError(err instanceof Error ? err.message : 'Expansion failed');
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

  const hierarchySummary = lastIngestResponse ? formatHierarchySummary(lastIngestResponse.hierarchy) : null;

  return (
    <div className="panel">
      <div className="panelTitle">Create Issue</div>
      <div className="panelBody">
        {/* Provider Selection */}
        <div style={{ marginBottom: 16 }}>
          <div className="muted" style={{ marginBottom: 8, fontWeight: 500 }}>
            Provider
          </div>
          <div className="segmented" style={{ marginBottom: 8 }}>
            {ISSUE_PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                className={`segBtn ${issueProvider === p ? 'active' : ''}`}
                onClick={() => setIssueProvider(p)}
                disabled={isSubmitting}
              >
                {p === 'github' ? 'GitHub' : 'Azure DevOps'}
              </button>
            ))}
          </div>

          {/* Mode Selection */}
          <div className="segmented">
            <button
              type="button"
              className={`segBtn ${formMode === 'create' ? 'active' : ''}`}
              onClick={() => setFormMode('create')}
              disabled={isSubmitting}
            >
              Create New
            </button>
            <button
              type="button"
              className={`segBtn ${formMode === 'init_existing' ? 'active' : ''}`}
              onClick={() => setFormMode('init_existing')}
              disabled={isSubmitting}
            >
              From Existing
            </button>
          </div>
        </div>

        {/* AI Expansion Section (only for create mode) */}
        {formMode === 'create' && (
          <div
            style={{
              marginBottom: 20,
              padding: 12,
              background: 'rgba(255,255,255,0.03)',
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

            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              <label className="label" style={{ flex: 1 }}>
                issue type
                <select
                  className="input"
                  value={issueType ?? ''}
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
                provider{defaultsLoaded ? '' : ' (loading...)'}
                <select
                  className="input"
                  value={expandProvider}
                  onChange={(e) => setExpandProvider(e.target.value)}
                >
                  {expandProvider &&
                  !RUN_PROVIDERS.includes(
                    expandProvider as CreateIssueRunProvider,
                  ) ? (
                    <option key={expandProvider} value={expandProvider}>
                      {expandProvider}
                    </option>
                  ) : null}
                  {RUN_PROVIDERS.map((p) => (
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

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                className="btn"
                type="button"
                onClick={() => void handleExpand()}
                disabled={isExpanding || !summary.trim()}
              >
                {isExpanding ? 'Expanding...' : 'Expand'}
              </button>

              {undoState ? (
                <button className="btn" type="button" onClick={handleUndo}>
                  Undo
                </button>
              ) : null}
            </div>
          </div>
        )}

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
            {issueProvider === 'azure_devops' ? 'repo (git URL or org/repo)' : 'repo (owner/repo)'}
            <input
              className="input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={issueProvider === 'azure_devops' ? 'https://dev.azure.com/org/project/_git/repo' : 'hansjm10/jeeves'}
            />
            {fieldErrors.repo && (
              <span style={{ color: 'var(--color-accent-red)', fontSize: 12 }}>{fieldErrors.repo}</span>
            )}
          </label>

          {formMode === 'create' ? (
            <>
              <label className="label">
                title
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Add a new feature"
                />
                {fieldErrors.title && (
                  <span style={{ color: 'var(--color-accent-red)', fontSize: 12 }}>{fieldErrors.title}</span>
                )}
              </label>
              <label className="label">
                body
                <textarea
                  className="textarea"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Describe the issue…"
                />
                {fieldErrors.body && (
                  <span style={{ color: 'var(--color-accent-red)', fontSize: 12 }}>{fieldErrors.body}</span>
                )}
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

              {/* GitHub-specific options */}
              {issueProvider === 'github' && (
                <>
                  <div className="muted" style={{ marginTop: 10 }}>
                    GitHub Options
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
                </>
              )}

              {/* Azure-specific create options */}
              {issueProvider === 'azure_devops' && (
                <>
                  <div className="muted" style={{ marginTop: 10 }}>
                    Azure DevOps Options
                  </div>
                  <label className="label">
                    work item type
                    <select
                      className="input"
                      value={azureWorkItemType}
                      onChange={(e) => setAzureWorkItemType(e.target.value as AzureWorkItemType | '')}
                    >
                      <option value="">Default</option>
                      {AZURE_WORK_ITEM_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label className="label">
                    area path
                    <input
                      className="input"
                      value={azureAreaPath}
                      onChange={(e) => setAzureAreaPath(e.target.value)}
                      placeholder="MyProject\Area"
                    />
                  </label>
                  <label className="label">
                    iteration path
                    <input
                      className="input"
                      value={azureIterationPath}
                      onChange={(e) => setAzureIterationPath(e.target.value)}
                      placeholder="MyProject\Sprint 1"
                    />
                  </label>
                  <label className="label">
                    tags (comma-separated)
                    <input
                      className="input"
                      value={azureTags}
                      onChange={(e) => setAzureTags(e.target.value)}
                      placeholder="frontend, priority-high"
                    />
                  </label>
                  <label className="label">
                    parent work item ID
                    <input
                      className="input"
                      value={azureParentId}
                      onChange={(e) => setAzureParentId(e.target.value)}
                      placeholder="123"
                    />
                  </label>
                  <label className="label">
                    organization override
                    <input
                      className="input"
                      value={azureOrganization}
                      onChange={(e) => setAzureOrganization(e.target.value)}
                      placeholder="https://dev.azure.com/myorg (from settings if empty)"
                    />
                  </label>
                  <label className="label">
                    project override
                    <input
                      className="input"
                      value={azureProject}
                      onChange={(e) => setAzureProject(e.target.value)}
                      placeholder="MyProject (from settings if empty)"
                    />
                  </label>
                </>
              )}
            </>
          ) : (
            <>
              {/* Init from existing mode */}
              <label className="label">
                {issueProvider === 'github' ? 'issue number or URL' : 'work item ID or URL'}
                <input
                  className="input"
                  value={existingRef}
                  onChange={(e) => setExistingRef(e.target.value)}
                  placeholder={issueProvider === 'github' ? '42 or https://github.com/...' : '12345 or https://dev.azure.com/...'}
                />
                {fieldErrors.existing && (
                  <span style={{ color: 'var(--color-accent-red)', fontSize: 12 }}>{fieldErrors.existing}</span>
                )}
              </label>

              {/* Azure-specific init-from-existing options */}
              {issueProvider === 'azure_devops' && (
                <>
                  <label className="label">
                    organization override
                    <input
                      className="input"
                      value={azureOrganization}
                      onChange={(e) => setAzureOrganization(e.target.value)}
                      placeholder="https://dev.azure.com/myorg (from settings if empty)"
                    />
                  </label>
                  <label className="label">
                    project override
                    <input
                      className="input"
                      value={azureProject}
                      onChange={(e) => setAzureProject(e.target.value)}
                      placeholder="MyProject (from settings if empty)"
                    />
                  </label>
                  <label
                    className="label"
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <input
                      type="checkbox"
                      checked={azureFetchHierarchy}
                      onChange={(e) => setAzureFetchHierarchy(e.target.checked)}
                      disabled={isSubmitting}
                    />
                    fetch hierarchy (parent/children)
                  </label>
                </>
              )}
            </>
          )}

          {/* Init/Select/Run Options */}
          <div className="muted" style={{ marginTop: 10 }}>
            Initialization
          </div>

          <label
            className="label"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <input
              type="checkbox"
              checked={init}
              disabled={isSubmitting || runRunning}
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
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <input
              type="checkbox"
              checked={autoSelect}
              disabled={!init || isSubmitting || runRunning}
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
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <input
              type="checkbox"
              checked={autoRun}
              disabled={
                !init || !autoSelect || isSubmitting || runRunning
              }
              onChange={(e) => setAutoRun(e.target.checked)}
            />
            start-run after create
          </label>

          <div className="muted">Run Provider</div>
          <div className="segmented" style={{ marginBottom: 10 }}>
            {RUN_PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                className={`segBtn ${runProvider === p ? 'active' : ''}`}
                onClick={() => setRunProvider(p)}
                disabled={
                  !autoRun ||
                  !init ||
                  !autoSelect ||
                  isSubmitting ||
                  runRunning
                }
              >
                {p}
              </button>
            ))}
          </div>

          {/* Errors */}
          {localError ? <div className="errorBox">{localError}</div> : null}
          {(createMutation.isError || initFromExistingMutation.isError) ? (
            <div className="errorBox">
              {(() => {
                const mutErr = createMutation.error ?? initFromExistingMutation.error;
                if (!mutErr) return 'Unknown error';
                // Don't echo PAT-related info
                return mutErr instanceof Error ? mutErr.message : String(mutErr);
              })()}
            </div>
          ) : null}

          {/* Field-level errors banner */}
          {Object.keys(fieldErrors).length > 0 && (
            <div className="errorBox" style={{ marginBottom: 8 }}>
              Please fix the highlighted fields above.
            </div>
          )}

          <button
            className="btn primary"
            type="submit"
            disabled={isSubmitting || (runRunning && init)}
          >
            {isSubmitting
              ? (formMode === 'create' ? 'Creating...' : 'Initializing...')
              : (formMode === 'create' ? 'Create Issue' : 'Initialize')}
          </button>
        </form>

        {/* Result Display */}
        {lastIngestResponse && (
          <div style={{ marginTop: 16 }}>
            <div className="muted">
              {lastIngestResponse.outcome === 'success' ? 'Created' : 'Created (partial)'}
            </div>

            {/* Remote link */}
            <div>
              URL:{' '}
              <a
                href={lastIngestResponse.remote.url}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {lastIngestResponse.remote.url}
              </a>
            </div>
            <div className="mono">
              {lastIngestResponse.remote.kind === 'work_item' ? 'work item' : 'issue'}: #{lastIngestResponse.remote.id} — {lastIngestResponse.remote.title}
            </div>

            {/* Hierarchy summary */}
            {hierarchySummary && (
              <div style={{ marginTop: 8 }}>
                <div className="muted">Hierarchy</div>
                <div style={{ fontSize: 13 }}>{hierarchySummary}</div>
                {lastIngestResponse.hierarchy?.parent && (
                  <div>
                    <a
                      href={lastIngestResponse.hierarchy.parent.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                      style={{ fontSize: 12 }}
                    >
                      Parent: {lastIngestResponse.hierarchy.parent.title}
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* Init result */}
            {lastIngestResponse.init && (
              <div style={{ marginTop: 8 }}>
                <div className="muted">Init</div>
                {lastIngestResponse.init.ok ? (
                  <div style={{ color: 'var(--color-accent-green)', fontSize: 13 }}>
                    Initialized: {lastIngestResponse.init.issue_ref} (branch: {lastIngestResponse.init.branch})
                  </div>
                ) : (
                  <div style={{ color: 'var(--color-accent-red)', fontSize: 13 }}>
                    Init failed: {lastIngestResponse.init.error}
                  </div>
                )}
              </div>
            )}

            {/* Auto-select result */}
            {lastIngestResponse.auto_select?.requested && (
              <div style={{ marginTop: 4 }}>
                <span style={{ color: lastIngestResponse.auto_select.ok ? 'var(--color-accent-green)' : 'var(--color-accent-red)', fontSize: 13 }}>
                  Auto-select: {lastIngestResponse.auto_select.ok ? 'OK' : `Failed${lastIngestResponse.auto_select.error ? ` — ${lastIngestResponse.auto_select.error}` : ''}`}
                </span>
              </div>
            )}

            {/* Auto-run result */}
            {lastIngestResponse.auto_run?.requested && (
              <div style={{ marginTop: 4 }}>
                <span style={{ color: lastIngestResponse.auto_run.ok ? 'var(--color-accent-green)' : 'var(--color-accent-red)', fontSize: 13 }}>
                  Auto-run: {lastIngestResponse.auto_run.ok ? 'OK' : `Failed${lastIngestResponse.auto_run.error ? ` — ${lastIngestResponse.auto_run.error}` : ''}`}
                </span>
              </div>
            )}

            {/* Warnings */}
            {lastIngestResponse.warnings.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="muted">Warnings</div>
                {lastIngestResponse.warnings.map((w, i) => (
                  <div key={i} style={{ color: 'var(--color-accent-amber)', fontSize: 13 }}>
                    {w}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
