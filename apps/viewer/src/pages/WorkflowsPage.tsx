import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import {
  useCreateWorkflowMutation,
  useSaveWorkflowMutation,
  useSelectIssueWorkflowMutation,
  useWorkflowByNameQuery,
  useWorkflowsQuery,
} from '../api/workflows.js';
import { WorkflowGraph, type WorkflowGraphSelection } from '../features/workflows/WorkflowGraph.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useUnsavedChanges } from '../ui/unsaved/UnsavedChangesProvider.js';
import { PROVIDERS, PROVIDER_CONFIG, getModelsForProvider, getModelInfo } from '../constants/workflow.js';
import './WorkflowsPage.css';

/** Add Phase dialog state */
type AddPhaseDialogState = { open: false } | { open: true };

/** Add Transition dialog state */
type AddTransitionDialogState = { open: false } | { open: true; from: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepCloneJson<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);
}

export function WorkflowsPage() {
  const baseUrl = useViewerServerBaseUrl();
  const stream = useViewerStream();
  const { isDirty, setDirty, confirmDiscard } = useUnsavedChanges();

  const workflowsQuery = useWorkflowsQuery(baseUrl);
  const workflows = useMemo(() => workflowsQuery.data?.workflows ?? [], [workflowsQuery.data]);

  const issueWorkflow =
    stream.state?.issue_json && typeof stream.state.issue_json.workflow === 'string'
      ? stream.state.issue_json.workflow
      : null;

  const currentIssuePhase =
    stream.state?.issue_json && typeof stream.state.issue_json.phase === 'string' ? stream.state.issue_json.phase : null;

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selection, setSelection] = useState<WorkflowGraphSelection>(null);
  const [draftWorkflow, setDraftWorkflow] = useState<Record<string, unknown> | null>(null);
  const [createName, setCreateName] = useState('');
  const [createFromSelected, setCreateFromSelected] = useState(true);
  const [resetPhaseOnSelect, setResetPhaseOnSelect] = useState(true);
  const lastLoadedNameRef = useRef<string | null>(null);
  const [addPhaseDialog, setAddPhaseDialog] = useState<AddPhaseDialogState>({ open: false });
  const [newPhaseId, setNewPhaseId] = useState('');
  const [addTransitionDialog, setAddTransitionDialog] = useState<AddTransitionDialogState>({ open: false });
  const [newTransitionTo, setNewTransitionTo] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    if (!issueWorkflow) return;
    if (issueWorkflow === selectedName) return;
    if (isDirty) return;
    setSelectedName(issueWorkflow);
  }, [isDirty, issueWorkflow, selectedName]);

  useEffect(() => {
    if (selectedName) return;
    if (workflows.length === 0) return;
    setSelectedName(workflows[0].name);
  }, [selectedName, workflows]);

  const selectedWorkflowQuery = useWorkflowByNameQuery(baseUrl, selectedName);
  const selectedRawWorkflow = selectedWorkflowQuery.data?.workflow ?? null;

  const saveMutation = useSaveWorkflowMutation(baseUrl);
  const createMutation = useCreateWorkflowMutation(baseUrl);
  const selectIssueWorkflowMutation = useSelectIssueWorkflowMutation(baseUrl);

  useEffect(() => {
    setSelection(null);
  }, [selectedName]);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    return () => setDirty(false);
  }, [setDirty]);

  useEffect(() => {
    const data = selectedWorkflowQuery.data;
    if (!data) return;
    if (isDirty && lastLoadedNameRef.current === data.name) return;
    lastLoadedNameRef.current = data.name;
    setDraftWorkflow(deepCloneJson(data.workflow));
  }, [isDirty, selectedWorkflowQuery.data]);

  const onSelectWorkflow = (name: string) => {
    if (name === selectedName) return;
    if (isDirty && !confirmDiscard('Discard unsaved workflow changes?')) return;
    setDirty(false);
    setDraftWorkflow(null);
    setSelectedName(name);
  };

  const updateDraft = (updater: (draft: Record<string, unknown>) => void) => {
    setDraftWorkflow((prev) => {
      if (!prev) return prev;
      const next = deepCloneJson(prev);
      updater(next);
      return next;
    });
    setDirty(true);
  };

  const setWorkflowField = (key: string, value: unknown) => {
    updateDraft((draft) => {
      const wf = isRecord(draft.workflow) ? draft.workflow : {};
      draft.workflow = wf;
      if (value === '' || value === undefined) delete wf[key];
      else wf[key] = value;
    });
  };

  const setPhaseField = (phaseId: string, key: string, value: unknown) => {
    updateDraft((draft) => {
      const phases = isRecord(draft.phases) ? draft.phases : {};
      draft.phases = phases;
      const phase = isRecord(phases[phaseId]) ? (phases[phaseId] as Record<string, unknown>) : {};
      phases[phaseId] = phase;
      if (value === '' || value === undefined) delete phase[key];
      else phase[key] = value;
    });
  };

  const setTransitionField = (from: string, to: string, key: string, value: unknown) => {
    updateDraft((draft) => {
      const phases = isRecord(draft.phases) ? draft.phases : {};
      draft.phases = phases;
      const phase = isRecord(phases[from]) ? (phases[from] as Record<string, unknown>) : null;
      if (!phase) return;
      const transitionsRaw = phase.transitions;
      if (!Array.isArray(transitionsRaw)) return;
      const idx = transitionsRaw.findIndex((t) => isRecord(t) && t.to === to);
      if (idx < 0) return;
      const nextTransition = isRecord(transitionsRaw[idx]) ? { ...(transitionsRaw[idx] as Record<string, unknown>) } : {};
      if (value === '' || value === undefined) delete nextTransition[key];
      else nextTransition[key] = value;
      const nextTransitions = transitionsRaw.slice();
      nextTransitions[idx] = nextTransition;
      phase.transitions = nextTransitions;
    });
  };

  /** Add a new phase with safe defaults */
  const addPhase = useCallback((phaseId: string) => {
    if (!phaseId.trim()) return;
    updateDraft((draft) => {
      const phases = isRecord(draft.phases) ? draft.phases : {};
      draft.phases = phases;
      if (phases[phaseId]) return; // already exists
      // Safe defaults: execute type with empty prompt (user must fill)
      phases[phaseId] = { type: 'execute', prompt: '', transitions: [] };
    });
    setSelection({ kind: 'node', id: phaseId });
  }, [updateDraft, setSelection]);

  /** Remove a phase by id */
  const removePhase = useCallback((phaseId: string) => {
    updateDraft((draft) => {
      const phases = isRecord(draft.phases) ? draft.phases : {};
      draft.phases = phases;
      delete phases[phaseId];
      // Also remove any transitions that point to this phase
      for (const [, phaseVal] of Object.entries(phases)) {
        if (!isRecord(phaseVal)) continue;
        const transitions = phaseVal.transitions;
        if (!Array.isArray(transitions)) continue;
        phaseVal.transitions = transitions.filter((t) => !(isRecord(t) && t.to === phaseId));
      }
      // Update workflow.start if it was this phase
      const wf = isRecord(draft.workflow) ? draft.workflow : {};
      if (wf.start === phaseId) delete wf.start;
    });
    if (selection?.kind === 'node' && selection.id === phaseId) {
      setSelection(null);
    }
  }, [updateDraft, selection, setSelection]);

  /** Add a transition from one phase to another */
  const addTransition = useCallback((from: string, to: string) => {
    if (!from.trim() || !to.trim()) return;
    updateDraft((draft) => {
      const phases = isRecord(draft.phases) ? draft.phases : {};
      draft.phases = phases;
      const phase = isRecord(phases[from]) ? (phases[from] as Record<string, unknown>) : null;
      if (!phase) return;
      const transitions = Array.isArray(phase.transitions) ? (phase.transitions as unknown[]).slice() : [];
      // Check if transition already exists
      if (transitions.some((t) => isRecord(t) && t.to === to)) return;
      transitions.push({ to, auto: false });
      phase.transitions = transitions;
    });
    setSelection({ kind: 'edge', from, to });
  }, [updateDraft, setSelection]);

  /** Remove a transition */
  const removeTransition = useCallback((from: string, to: string) => {
    updateDraft((draft) => {
      const phases = isRecord(draft.phases) ? draft.phases : {};
      draft.phases = phases;
      const phase = isRecord(phases[from]) ? (phases[from] as Record<string, unknown>) : null;
      if (!phase) return;
      const transitions = phase.transitions;
      if (!Array.isArray(transitions)) return;
      phase.transitions = transitions.filter((t) => !(isRecord(t) && t.to === to));
    });
    if (selection?.kind === 'edge' && selection.from === from && selection.to === to) {
      setSelection(null);
    }
  }, [updateDraft, selection, setSelection]);

  const onSave = async () => {
    if (!selectedName) return;
    if (!draftWorkflow) return;
    saveMutation.reset();
    saveMutation.mutate(
      { name: selectedName, workflow: draftWorkflow },
      {
        onSuccess: (data) => {
          setDraftWorkflow(deepCloneJson(data.workflow));
          setDirty(false);
          lastLoadedNameRef.current = data.name;
        },
      },
    );
  };

  const onReload = async () => {
    if (!selectedName) return;
    if (isDirty && !confirmDiscard('Discard unsaved workflow changes and reload?')) return;
    saveMutation.reset();
    setDirty(false);
    const res = await selectedWorkflowQuery.refetch();
    if (res.data) {
      lastLoadedNameRef.current = res.data.name;
      setDraftWorkflow(deepCloneJson(res.data.workflow));
    }
  };

  const onCreate = () => {
    const name = createName.trim();
    if (!name) return;
    createMutation.reset();
    createMutation.mutate(
      { name, ...(createFromSelected && selectedName ? { from: selectedName } : {}) },
      {
        onSuccess: (data) => {
          setCreateName('');
          setSelectedName(data.name);
          lastLoadedNameRef.current = data.name;
          setDraftWorkflow(deepCloneJson(data.workflow));
          setDirty(false);
        },
      },
    );
  };

  const onSetActive = () => {
    if (!selectedName) return;
    selectIssueWorkflowMutation.reset();
    selectIssueWorkflowMutation.mutate({ workflow: selectedName, reset_phase: resetPhaseOnSelect });
  };

  const workflowSection =
    draftWorkflow && isRecord(draftWorkflow.workflow) ? (draftWorkflow.workflow as Record<string, unknown>) : null;

  const phasesSection = draftWorkflow && isRecord(draftWorkflow.phases) ? (draftWorkflow.phases as Record<string, unknown>) : null;

  /** Get list of phase IDs from draft */
  const phaseIds = useMemo(() => {
    if (!phasesSection) return [];
    return Object.keys(phasesSection).sort();
  }, [phasesSection]);

  const selectedPhase =
    selection?.kind === 'node' && phasesSection && isRecord(phasesSection[selection.id])
      ? (phasesSection[selection.id] as Record<string, unknown>)
      : null;

  const selectedTransition =
    selection?.kind === 'edge' && phasesSection && isRecord(phasesSection[selection.from])
      ? (() => {
          const phase = phasesSection[selection.from] as Record<string, unknown>;
          const transitions = phase.transitions;
          if (!Array.isArray(transitions)) return null;
          const t = transitions.find((v) => isRecord(v) && v.to === selection.to);
          return isRecord(t) ? (t as Record<string, unknown>) : null;
        })()
      : null;

  return (
    <div className="wf-container">
      {/* Full-bleed graph canvas -- always fills the container */}
      <div className="wf-graph-canvas">
        <WorkflowGraph
          workflow={draftWorkflow ?? selectedRawWorkflow}
          currentPhaseId={currentIssuePhase}
          selection={selection}
          onSelectionChange={setSelection}
        />
      </div>

      {/* Collapsible sidebar overlay (left side) */}
      <aside className={`wf-sidebar ${sidebarOpen ? 'open' : 'collapsed'}`}>
        <div className="wf-sidebar-header">
          <button
            className="wf-sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarOpen ? '\u2190' : '\u2630'}
          </button>
          {sidebarOpen && <h2 className="wf-sidebar-title">Workflows</h2>}
          {sidebarOpen && (
            <button className="wf-btn" onClick={() => void workflowsQuery.refetch()}>
              Refresh
            </button>
          )}
        </div>
        {sidebarOpen && (
          <>
            <div className="wf-issue-ref">
              {stream.state?.issue_ref ? `Issue: ${stream.state.issue_ref}` : 'No issue selected'}
            </div>

            {workflowsQuery.isLoading ? <div className="wf-loading">Loading...</div> : null}
            {workflowsQuery.isError ? (
              <div className="wf-error">
                {workflowsQuery.error instanceof Error ? workflowsQuery.error.message : String(workflowsQuery.error)}
              </div>
            ) : null}

            <div className="wf-workflow-list">
              {workflows.map((w) => (
                <button
                  key={w.name}
                  className={`wf-workflow-item ${w.name === selectedName ? 'selected' : ''}`}
                  onClick={() => onSelectWorkflow(w.name)}
                >
                  <span>{w.name}</span>
                  {issueWorkflow && w.name === issueWorkflow ? (
                    <span className="wf-workflow-active-badge">active</span>
                  ) : null}
                </button>
              ))}
            </div>

            <div className="wf-create-section">
              <div className="wf-create-section-title">Create workflow</div>
              <div className="wf-create-form">
                <input
                  className="wf-input"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="name"
                />
                <button className="wf-btn wf-btn-primary" onClick={onCreate} disabled={createMutation.isPending}>
                  Create
                </button>
              </div>
              <label className="wf-checkbox-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={createFromSelected}
                  onChange={(e) => setCreateFromSelected(e.target.checked)}
                />
                Clone from selected
              </label>
              {createMutation.isError ? (
                <div className="wf-error">
                  {createMutation.error instanceof Error ? createMutation.error.message : String(createMutation.error)}
                </div>
              ) : null}
            </div>
          </>
        )}
      </aside>

      {/* Slide-out inspector (right side) -- shown when selection exists or workflow loaded */}
      <aside className={`wf-inspector ${selection || draftWorkflow ? 'open' : ''}`}>
        <div className="wf-inspector-header">
          <h2 className="wf-inspector-title">Inspector</h2>
          <div className="wf-inspector-actions">
            <button
              className="wf-btn"
              onClick={() => void onReload()}
              disabled={!selectedName || selectedWorkflowQuery.isLoading}
            >
              Reload
            </button>
            <button
              className="wf-btn wf-btn-primary"
              onClick={() => void onSave()}
              disabled={!isDirty || saveMutation.isPending}
            >
              Save
            </button>
            <button className="wf-inspector-close" onClick={() => setSelection(null)} title="Close inspector">
              ×
            </button>
          </div>
        </div>

        <div className="wf-inspector-info">
          <div>Selected: <strong>{selectedName || '(none)'}</strong></div>
          <div className="wf-inspector-selection" style={{ marginTop: 4 }}>
            Selection:{' '}
            <strong>
              {selection?.kind === 'node'
                ? `phase ${selection.id}`
                : selection?.kind === 'edge'
                  ? `${selection.from} -> ${selection.to}`
                  : '(none)'}
            </strong>
          </div>
        </div>

        {selectIssueWorkflowMutation.isError ? (
          <div className="wf-error">
            {selectIssueWorkflowMutation.error instanceof Error
              ? selectIssueWorkflowMutation.error.message
              : String(selectIssueWorkflowMutation.error)}
          </div>
        ) : null}
        {selectedWorkflowQuery.isLoading ? <div className="wf-loading">Loading...</div> : null}
        {selectedWorkflowQuery.isError ? (
          <div className="wf-error">
            {selectedWorkflowQuery.error instanceof Error
              ? selectedWorkflowQuery.error.message
              : String(selectedWorkflowQuery.error)}
          </div>
        ) : null}
        {saveMutation.isError ? (
          <div className="wf-error">
            {saveMutation.error instanceof Error ? saveMutation.error.message : String(saveMutation.error)}
          </div>
        ) : null}

        {draftWorkflow && (
          <div className="wf-inspector-body">
            {/* Card 1: Workflow Defaults -- collapsible */}
            <details className="wf-card" open={!selection}>
              <summary className="wf-card-header">Workflow Defaults</summary>
              <div className="wf-card-body">
                <div className="wf-form-grid">
                  <div className="wf-field">
                    <span className="wf-field-label">start</span>
                    <input
                      className="wf-input"
                      value={workflowSection && typeof workflowSection.start === 'string' ? workflowSection.start : ''}
                      onChange={(e) => setWorkflowField('start', e.target.value)}
                    />
                  </div>
                  <div className="wf-field">
                    <span className="wf-field-label">default_provider</span>
                    <div className="wf-seg-row">
                      {PROVIDERS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          className={`wf-seg-option ${workflowSection?.default_provider === p ? 'selected' : ''}`}
                          onClick={() => {
                            setWorkflowField('default_provider', p);
                            // Clear model if switching providers (model may not be valid for new provider)
                            if (workflowSection?.default_provider !== p) {
                              setWorkflowField('default_model', undefined);
                              // Clear model-dependent fields when switching providers (avoids hidden invalid state)
                              setWorkflowField('default_reasoning_effort', undefined);
                              setWorkflowField('default_thinking_budget', undefined);
                            }
                          }}
                          title={PROVIDER_CONFIG[p].hint}
                        >
                          {p}
                        </button>
                      ))}
                      {typeof workflowSection?.default_provider === 'string' && (
                        <button
                          type="button"
                          className="wf-seg-clear"
                          onClick={() => {
                            setWorkflowField('default_provider', undefined);
                            setWorkflowField('default_model', undefined);
                            setWorkflowField('default_reasoning_effort', undefined);
                            setWorkflowField('default_thinking_budget', undefined);
                          }}
                          title="Clear"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="wf-field">
                    <span className="wf-field-label">default_model</span>
                    {(() => {
                      const effectiveProvider = typeof workflowSection?.default_provider === 'string'
                        ? workflowSection.default_provider
                        : undefined;
                      const models = getModelsForProvider(effectiveProvider);
                      if (!effectiveProvider) {
                        return <span className="wf-field-hint">Select a provider first</span>;
                      }
                      return (
                        <div className="wf-seg-row">
                          {models.map((m) => {
                            const info = getModelInfo(effectiveProvider, m);
                            return (
                              <button
                                key={m}
                                type="button"
                                className={`wf-seg-option ${workflowSection?.default_model === m ? 'selected' : ''}`}
                                onClick={() => {
                                  setWorkflowField('default_model', m);

                                  // Clear invalid model-dependent selections when switching models
                                  if (!info?.reasoningEfforts) {
                                    setWorkflowField('default_reasoning_effort', undefined);
                                  } else if (typeof workflowSection?.default_reasoning_effort === 'string') {
                                    const ok = info.reasoningEfforts.some((r) => r.id === workflowSection.default_reasoning_effort);
                                    if (!ok) setWorkflowField('default_reasoning_effort', undefined);
                                  }

                                  if (!info?.thinkingBudgets) {
                                    setWorkflowField('default_thinking_budget', undefined);
                                  } else if (typeof workflowSection?.default_thinking_budget === 'string') {
                                    const ok = info.thinkingBudgets.some((t) => t.id === workflowSection.default_thinking_budget);
                                    if (!ok) setWorkflowField('default_thinking_budget', undefined);
                                  }
                                }}
                                title={info?.hint}
                                data-tier={info?.tier}
                              >
                                {info?.label ?? m}
                              </button>
                            );
                          })}
                          {typeof workflowSection?.default_model === 'string' && (
                            <button
                              type="button"
                              className="wf-seg-clear"
                              onClick={() => {
                                setWorkflowField('default_model', undefined);
                                setWorkflowField('default_reasoning_effort', undefined);
                                setWorkflowField('default_thinking_budget', undefined);
                              }}
                              title="Clear"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {/* Reasoning/Thinking Mode - shown when model supports it */}
                  {(() => {
                    const effectiveProvider = typeof workflowSection?.default_provider === 'string'
                      ? workflowSection.default_provider
                      : undefined;
                    const effectiveModel = typeof workflowSection?.default_model === 'string'
                      ? workflowSection.default_model
                      : undefined;
                    const modelInfo = effectiveProvider && effectiveModel
                      ? getModelInfo(effectiveProvider, effectiveModel)
                      : undefined;

                    // Codex reasoning efforts
                    if (modelInfo?.reasoningEfforts) {
                      return (
                        <div className="wf-field">
                          <span className="wf-field-label">reasoning_effort</span>
                          <div className="wf-seg-row">
                            {modelInfo.reasoningEfforts.map((r) => (
                              <button
                                key={r.id}
                                type="button"
                                className={`wf-seg-option ${workflowSection?.default_reasoning_effort === r.id ? 'selected' : ''}`}
                                onClick={() => setWorkflowField('default_reasoning_effort', r.id)}
                                title={r.hint}
                              >
                                {r.label}
                              </button>
                            ))}
                            {typeof workflowSection?.default_reasoning_effort === 'string' && (
                              <button
                                type="button"
                                className="wf-seg-clear"
                                onClick={() => setWorkflowField('default_reasoning_effort', undefined)}
                                title="Clear (use default)"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }

                    // Claude thinking budgets
                    if (modelInfo?.thinkingBudgets) {
                      return (
                        <div className="wf-field">
                          <span className="wf-field-label">thinking_budget</span>
                          <div className="wf-seg-row">
                            {modelInfo.thinkingBudgets.map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                className={`wf-seg-option ${workflowSection?.default_thinking_budget === t.id ? 'selected' : ''}`}
                                onClick={() => setWorkflowField('default_thinking_budget', t.id)}
                                title={t.hint}
                              >
                                {t.label}
                              </button>
                            ))}
                            {typeof workflowSection?.default_thinking_budget === 'string' && (
                              <button
                                type="button"
                                className="wf-seg-clear"
                                onClick={() => setWorkflowField('default_thinking_budget', undefined)}
                                title="Clear"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }

                    return null;
                  })()}
                </div>
              </div>
            </details>

            {/* Card 2: Phase Editor -- shown when node selected */}
            {selection?.kind === 'node' && (
              <details className="wf-card" open>
                <summary className="wf-card-header">
                  Phase: {selection.id}
                  <button
                    className="wf-btn-danger"
                    onClick={(e) => {
                      e.preventDefault();
                      if (confirm(`Remove phase "${selection.id}"?`)) {
                        removePhase(selection.id);
                      }
                    }}
                  >
                    Remove
                  </button>
                </summary>
                <div className="wf-card-body">
                  <div className="wf-form-grid">
                    <div className="wf-field">
                      <span className="wf-field-label">prompt</span>
                      <input
                        className="wf-input"
                        value={selectedPhase && typeof selectedPhase.prompt === 'string' ? selectedPhase.prompt : ''}
                        onChange={(e) => setPhaseField(selection.id, 'prompt', e.target.value)}
                      />
                    </div>
                    <div className="wf-field">
                      <span className="wf-field-label">type</span>
                      <input
                        className="wf-input"
                        value={selectedPhase && typeof selectedPhase.type === 'string' ? selectedPhase.type : ''}
                        onChange={(e) => setPhaseField(selection.id, 'type', e.target.value)}
                      />
                    </div>
                    <div className="wf-field">
                      <span className="wf-field-label">provider</span>
                      <div className="wf-seg-row">
                        {PROVIDERS.map((p) => {
                          const isSelected = selectedPhase?.provider === p;
                          const isEffective = !selectedPhase?.provider && workflowSection?.default_provider === p;
                          return (
                            <button
                              key={p}
                              type="button"
                              className={`wf-seg-option ${isSelected ? 'selected' : ''} ${isEffective ? 'effective' : ''}`}
                              onClick={() => {
                                const prevEffectiveProvider = typeof selectedPhase?.provider === 'string'
                                  ? selectedPhase.provider
                                  : typeof workflowSection?.default_provider === 'string'
                                    ? workflowSection.default_provider
                                    : undefined;
                                setPhaseField(selection.id, 'provider', p);
                                // Clear model if switching providers (model may not be valid for new provider)
                                if (prevEffectiveProvider !== p) {
                                  setPhaseField(selection.id, 'model', undefined);
                                  // Clear model-dependent fields when switching providers (avoids hidden invalid state)
                                  setPhaseField(selection.id, 'reasoning_effort', undefined);
                                  setPhaseField(selection.id, 'thinking_budget', undefined);
                                }
                              }}
                              title={PROVIDER_CONFIG[p].hint}
                            >
                              {p}
                            </button>
                          );
                        })}
                        {typeof selectedPhase?.provider === 'string' && (
                          <button
                            type="button"
                            className="wf-seg-clear"
                            onClick={() => setPhaseField(selection.id, 'provider', undefined)}
                            title="Use workflow default"
                          >
                            ×
                          </button>
                        )}
                      </div>
                      {!selectedPhase?.provider && typeof workflowSection?.default_provider === 'string' && (
                        <div className="wf-effective-row">
                          <span className="wf-effective-label">Using:</span>
                          <span className="wf-effective-inherited">{String(workflowSection.default_provider)} (workflow default)</span>
                        </div>
                      )}
                    </div>
                    <div className="wf-field">
                      <span className="wf-field-label">model</span>
                      {(() => {
                        // Effective provider: phase override or workflow default
                        const effectiveProvider = typeof selectedPhase?.provider === 'string'
                          ? selectedPhase.provider
                          : typeof workflowSection?.default_provider === 'string'
                            ? workflowSection.default_provider
                            : undefined;
                        const models = getModelsForProvider(effectiveProvider);
                        if (!effectiveProvider) {
                          return <span className="wf-field-hint">Select a provider first</span>;
                        }
                        return (
                          <>
                            <div className="wf-seg-row">
                              {models.map((m) => {
                                const info = getModelInfo(effectiveProvider, m);
                                const isSelected = selectedPhase?.model === m;
                                const isEffective = !selectedPhase?.model && workflowSection?.default_model === m;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    className={`wf-seg-option ${isSelected ? 'selected' : ''} ${isEffective ? 'effective' : ''}`}
                                    onClick={() => {
                                      setPhaseField(selection.id, 'model', m);

                                      // Clear invalid model-dependent selections when switching models
                                      if (!info?.reasoningEfforts) {
                                        setPhaseField(selection.id, 'reasoning_effort', undefined);
                                      } else if (typeof selectedPhase?.reasoning_effort === 'string') {
                                        const ok = info.reasoningEfforts.some((r) => r.id === selectedPhase.reasoning_effort);
                                        if (!ok) setPhaseField(selection.id, 'reasoning_effort', undefined);
                                      }

                                      if (!info?.thinkingBudgets) {
                                        setPhaseField(selection.id, 'thinking_budget', undefined);
                                      } else if (typeof selectedPhase?.thinking_budget === 'string') {
                                        const ok = info.thinkingBudgets.some((t) => t.id === selectedPhase.thinking_budget);
                                        if (!ok) setPhaseField(selection.id, 'thinking_budget', undefined);
                                      }
                                    }}
                                    title={info?.hint}
                                    data-tier={info?.tier}
                                  >
                                    {info?.label ?? m}
                                  </button>
                                );
                              })}
                              {typeof selectedPhase?.model === 'string' && (
                                <button
                                  type="button"
                                  className="wf-seg-clear"
                                  onClick={() => setPhaseField(selection.id, 'model', undefined)}
                                  title="Use workflow default"
                                >
                                  ×
                                </button>
                              )}
                            </div>
                            {!selectedPhase?.model && typeof workflowSection?.default_model === 'string' && (
                              <div className="wf-effective-row">
                                <span className="wf-effective-label">Using:</span>
                                <span className="wf-effective-inherited">{String(workflowSection.default_model)} (workflow default)</span>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    {/* Reasoning/Thinking Mode for phase - shown when model supports it */}
                    {(() => {
                      // Effective provider and model for this phase
                      const effectiveProvider = typeof selectedPhase?.provider === 'string'
                        ? selectedPhase.provider
                        : typeof workflowSection?.default_provider === 'string'
                          ? workflowSection.default_provider
                          : undefined;
                      const effectiveModel = typeof selectedPhase?.model === 'string'
                        ? selectedPhase.model
                        : typeof workflowSection?.default_model === 'string'
                          ? workflowSection.default_model
                          : undefined;
                      const modelInfo = effectiveProvider && effectiveModel
                        ? getModelInfo(effectiveProvider, effectiveModel)
                        : undefined;

                      // Codex reasoning efforts
                      if (modelInfo?.reasoningEfforts) {
                        const isInherited = !selectedPhase?.reasoning_effort && typeof workflowSection?.default_reasoning_effort === 'string';
                        return (
                          <div className="wf-field">
                            <span className="wf-field-label">reasoning_effort</span>
                            <div className="wf-seg-row">
                              {modelInfo.reasoningEfforts.map((r) => {
                                const isSelected = selectedPhase?.reasoning_effort === r.id;
                                const isEffective = !selectedPhase?.reasoning_effort && workflowSection?.default_reasoning_effort === r.id;
                                return (
                                  <button
                                    key={r.id}
                                    type="button"
                                    className={`wf-seg-option ${isSelected ? 'selected' : ''} ${isEffective ? 'effective' : ''}`}
                                    onClick={() => setPhaseField(selection.id, 'reasoning_effort', r.id)}
                                    title={r.hint}
                                  >
                                    {r.label}
                                  </button>
                                );
                              })}
                              {typeof selectedPhase?.reasoning_effort === 'string' && (
                                <button
                                  type="button"
                                  className="wf-seg-clear"
                                  onClick={() => setPhaseField(selection.id, 'reasoning_effort', undefined)}
                                  title="Use workflow default"
                                >
                                  ×
                                </button>
                              )}
                            </div>
                            {isInherited && (
                              <div className="wf-effective-row">
                                <span className="wf-effective-label">Using:</span>
                                <span className="wf-effective-inherited">{String(workflowSection.default_reasoning_effort)} (workflow default)</span>
                              </div>
                            )}
                          </div>
                        );
                      }

                      // Claude thinking budgets
                      if (modelInfo?.thinkingBudgets) {
                        const isInherited = !selectedPhase?.thinking_budget && typeof workflowSection?.default_thinking_budget === 'string';
                        return (
                          <div className="wf-field">
                            <span className="wf-field-label">thinking_budget</span>
                            <div className="wf-seg-row">
                              {modelInfo.thinkingBudgets.map((t) => {
                                const isSelected = selectedPhase?.thinking_budget === t.id;
                                const isEffective = !selectedPhase?.thinking_budget && workflowSection?.default_thinking_budget === t.id;
                                return (
                                  <button
                                    key={t.id}
                                    type="button"
                                    className={`wf-seg-option ${isSelected ? 'selected' : ''} ${isEffective ? 'effective' : ''}`}
                                    onClick={() => setPhaseField(selection.id, 'thinking_budget', t.id)}
                                    title={t.hint}
                                  >
                                    {t.label}
                                  </button>
                                );
                              })}
                              {typeof selectedPhase?.thinking_budget === 'string' && (
                                <button
                                  type="button"
                                  className="wf-seg-clear"
                                  onClick={() => setPhaseField(selection.id, 'thinking_budget', undefined)}
                                  title="Use workflow default"
                                >
                                  ×
                                </button>
                              )}
                            </div>
                            {isInherited && (
                              <div className="wf-effective-row">
                                <span className="wf-effective-label">Using:</span>
                                <span className="wf-effective-inherited">{String(workflowSection.default_thinking_budget)} (workflow default)</span>
                              </div>
                            )}
                          </div>
                        );
                      }

                      return null;
                    })()}
                    <div className="wf-field">
                      <span className="wf-field-label">description</span>
                      <textarea
                        className="wf-textarea"
                        value={
                          selectedPhase && typeof selectedPhase.description === 'string' ? selectedPhase.description : ''
                        }
                        onChange={(e) => setPhaseField(selection.id, 'description', e.target.value)}
                        rows={3}
                      />
                    </div>
                    <div className="wf-field">
                      <span className="wf-field-label">allowed_writes (one per line)</span>
                      <textarea
                        className="wf-textarea"
                        value={
                          selectedPhase && Array.isArray(selectedPhase.allowed_writes)
                            ? (selectedPhase.allowed_writes as unknown[]).filter((v) => typeof v === 'string').join('\n')
                            : ''
                        }
                        onChange={(e) => {
                          const next = e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean);
                          setPhaseField(selection.id, 'allowed_writes', next.length ? next : undefined);
                        }}
                        rows={3}
                      />
                    </div>
                  </div>

                  {/* Transitions from this phase */}
                  <div style={{ marginTop: 12 }}>
                    <div className="wf-section-header">
                      <span className="wf-section-title">Transitions from {selection.id}</span>
                    </div>
                    {addTransitionDialog.open && addTransitionDialog.from === selection.id ? (
                      <div className="wf-inline-form" style={{ marginBottom: 8 }}>
                        <select
                          className="wf-select"
                          value={newTransitionTo}
                          onChange={(e) => setNewTransitionTo(e.target.value)}
                        >
                          <option value="">Select target phase...</option>
                          {phaseIds
                            .filter((id) => id !== selection.id)
                            .filter((id) => {
                              const phase = phasesSection?.[selection.id];
                              if (!isRecord(phase)) return true;
                              const transitions = phase.transitions;
                              if (!Array.isArray(transitions)) return true;
                              return !transitions.some((t) => isRecord(t) && t.to === id);
                            })
                            .map((id) => (
                              <option key={id} value={id}>
                                {id}
                              </option>
                            ))}
                        </select>
                        <button
                          className="wf-btn wf-btn-primary"
                          onClick={() => {
                            addTransition(selection.id, newTransitionTo);
                            setAddTransitionDialog({ open: false });
                            setNewTransitionTo('');
                          }}
                          disabled={!newTransitionTo}
                        >
                          Add
                        </button>
                        <button
                          className="wf-btn"
                          onClick={() => {
                            setAddTransitionDialog({ open: false });
                            setNewTransitionTo('');
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="wf-btn"
                        onClick={() => {
                          setNewTransitionTo('');
                          setAddTransitionDialog({ open: true, from: selection.id });
                        }}
                        style={{ marginBottom: 8 }}
                      >
                        + Add Transition
                      </button>
                    )}
                  </div>
                </div>
              </details>
            )}

            {/* Card 3: Transition Editor -- shown when edge selected */}
            {selection?.kind === 'edge' && (
              <details className="wf-card" open>
                <summary className="wf-card-header">
                  Transition: {selection.from} &rarr; {selection.to}
                  <button
                    className="wf-btn-danger"
                    onClick={(e) => {
                      e.preventDefault();
                      if (confirm(`Remove transition "${selection.from} -> ${selection.to}"?`)) {
                        removeTransition(selection.from, selection.to);
                      }
                    }}
                  >
                    Remove
                  </button>
                </summary>
                <div className="wf-card-body">
                  <div className="wf-form-grid">
                    <div className="wf-field">
                      <span className="wf-field-label">to</span>
                      <select
                        className="wf-select"
                        value={selection.to}
                        onChange={(e) => {
                          const oldTo = selection.to;
                          const newTo = e.target.value;
                          if (oldTo === newTo) return;
                          updateDraft((draft) => {
                            const phases = isRecord(draft.phases) ? draft.phases : {};
                            const phase = isRecord(phases[selection.from]) ? (phases[selection.from] as Record<string, unknown>) : null;
                            if (!phase) return;
                            const transitions = phase.transitions;
                            if (!Array.isArray(transitions)) return;
                            const idx = transitions.findIndex((t) => isRecord(t) && t.to === oldTo);
                            if (idx < 0) return;
                            const updated = { ...(transitions[idx] as Record<string, unknown>), to: newTo };
                            const nextTransitions = transitions.slice();
                            nextTransitions[idx] = updated;
                            phase.transitions = nextTransitions;
                          });
                          setSelection({ kind: 'edge', from: selection.from, to: newTo });
                        }}
                      >
                        {phaseIds.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label className="wf-checkbox-label">
                      <input
                        type="checkbox"
                        checked={selectedTransition?.auto === true}
                        onChange={(e) => setTransitionField(selection.from, selection.to, 'auto', e.target.checked)}
                      />
                      auto
                    </label>
                    <div className="wf-field">
                      <span className="wf-field-label">when</span>
                      <input
                        className="wf-input"
                        value={selectedTransition && typeof selectedTransition.when === 'string' ? selectedTransition.when : ''}
                        onChange={(e) => setTransitionField(selection.from, selection.to, 'when', e.target.value)}
                        placeholder="(optional)"
                      />
                    </div>
                    <div className="wf-field">
                      <span className="wf-field-label">priority</span>
                      <input
                        className="wf-input"
                        value={
                          selectedTransition && typeof selectedTransition.priority === 'number'
                            ? String(selectedTransition.priority)
                            : ''
                        }
                        onChange={(e) => {
                          const raw = e.target.value.trim();
                          if (!raw) setTransitionField(selection.from, selection.to, 'priority', undefined);
                          else setTransitionField(selection.from, selection.to, 'priority', Number(raw));
                        }}
                        placeholder="(optional)"
                      />
                    </div>
                  </div>
                </div>
              </details>
            )}

            {/* Phases section -- Add Phase button */}
            <div className="wf-card">
              <div className="wf-card-header">Phases</div>
              {!addPhaseDialog.open ? (
                <button
                  className="wf-btn"
                  onClick={() => {
                    setNewPhaseId('');
                    setAddPhaseDialog({ open: true });
                  }}
                >
                  + Add Phase
                </button>
              ) : (
                <div className="wf-inline-form">
                  <input
                    className="wf-input"
                    value={newPhaseId}
                    onChange={(e) => setNewPhaseId(e.target.value)}
                    placeholder="phase_id"
                  />
                  <button
                    className="wf-btn wf-btn-primary"
                    onClick={() => {
                      addPhase(newPhaseId);
                      setAddPhaseDialog({ open: false });
                      setNewPhaseId('');
                    }}
                    disabled={!newPhaseId.trim() || phaseIds.includes(newPhaseId.trim())}
                  >
                    Add
                  </button>
                  <button className="wf-btn" onClick={() => setAddPhaseDialog({ open: false })}>
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Set Active section */}
            <div className="wf-set-active-section">
              <button
                className="wf-btn wf-btn-primary"
                onClick={onSetActive}
                disabled={!selectedName || !stream.state?.issue_ref || selectIssueWorkflowMutation.isPending}
                title={!stream.state?.issue_ref ? 'Select an issue first' : undefined}
              >
                Set active
              </button>
              <label className="wf-checkbox-label">
                <input
                  type="checkbox"
                  checked={resetPhaseOnSelect}
                  onChange={(e) => setResetPhaseOnSelect(e.target.checked)}
                />
                Reset phase
              </label>
            </div>

            {/* JSON Preview */}
            <details className="wf-json-details">
              <summary>Draft JSON</summary>
              <pre className="wf-json-pre">{JSON.stringify(draftWorkflow, null, 2)}</pre>
            </details>
          </div>
        )}
      </aside>
    </div>
  );
}
