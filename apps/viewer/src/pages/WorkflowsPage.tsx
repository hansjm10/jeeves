import { useEffect, useMemo, useRef, useState } from 'react';

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
    saveMutation.reset();
  }, [isDirty, saveMutation, selectedWorkflowQuery.data]);

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
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr 320px',
        gap: 12,
        padding: 12,
        alignItems: 'stretch',
      }}
    >
      <section
        aria-label="workflow list"
        style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, minHeight: 240 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Workflows</h2>
          <button onClick={() => void workflowsQuery.refetch()} style={{ fontSize: 12 }}>
            Refresh
          </button>
        </div>

        {stream.state?.issue_ref ? (
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>Issue: {stream.state.issue_ref}</div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>No issue selected</div>
        )}

        <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 10 }}>
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>Create workflow</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="name"
              style={{ flex: 1, fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
            />
            <button onClick={onCreate} style={{ fontSize: 12 }} disabled={createMutation.isPending}>
              Create
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, opacity: 0.85 }}>
            <input
              type="checkbox"
              checked={createFromSelected}
              onChange={(e) => setCreateFromSelected(e.target.checked)}
            />
            Clone from selected
          </label>
          {createMutation.isError ? (
            <div style={{ marginTop: 6, fontSize: 12, color: '#b00' }}>
              {createMutation.error instanceof Error ? createMutation.error.message : String(createMutation.error)}
            </div>
          ) : null}
        </div>

        {workflowsQuery.isLoading ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>Loading…</div> : null}
        {workflowsQuery.isError ? (
          <div style={{ marginTop: 8, fontSize: 12, color: '#b00' }}>
            {workflowsQuery.error instanceof Error ? workflowsQuery.error.message : String(workflowsQuery.error)}
          </div>
        ) : null}

        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {workflows.map((w) => (
            <button
              key={w.name}
              onClick={() => onSelectWorkflow(w.name)}
              style={{
                textAlign: 'left',
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid #ddd',
                background: w.name === selectedName ? '#eef5ff' : 'white',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {w.name}
              {issueWorkflow && w.name === issueWorkflow ? <span style={{ opacity: 0.7 }}> (active)</span> : null}
            </button>
          ))}
        </div>
      </section>
      <section
        aria-label="workflow graph"
        style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, minHeight: 240 }}
      >
        <h2 style={{ margin: 0, fontSize: 14 }}>Graph</h2>
        <div style={{ marginTop: 8, height: 520 }}>
          <WorkflowGraph
            workflow={selectedRawWorkflow}
            currentPhaseId={currentIssuePhase}
            selection={selection}
            onSelectionChange={setSelection}
          />
        </div>
      </section>
      <section
        aria-label="workflow inspector"
        style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, minHeight: 240 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 14 }}>Inspector</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => void onReload()}
              style={{ fontSize: 12 }}
              disabled={!selectedName || selectedWorkflowQuery.isLoading}
            >
              Reload
            </button>
            <button onClick={() => void onSave()} style={{ fontSize: 12 }} disabled={!isDirty || saveMutation.isPending}>
              Save
            </button>
          </div>
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>Selected: {selectedName ? selectedName : '(none)'}</div>
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
          Selection:{' '}
          {selection?.kind === 'node'
            ? `phase ${selection.id}`
            : selection?.kind === 'edge'
              ? `transition ${selection.from} → ${selection.to}`
              : '(none)'}
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={onSetActive}
            style={{ fontSize: 12 }}
            disabled={!selectedName || !stream.state?.issue_ref || selectIssueWorkflowMutation.isPending}
            title={!stream.state?.issue_ref ? 'Select an issue first' : undefined}
          >
            Set active
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 }}>
            <input
              type="checkbox"
              checked={resetPhaseOnSelect}
              onChange={(e) => setResetPhaseOnSelect(e.target.checked)}
            />
            Reset phase
          </label>
        </div>
        {selectIssueWorkflowMutation.isError ? (
          <div style={{ marginTop: 6, fontSize: 12, color: '#b00' }}>
            {selectIssueWorkflowMutation.error instanceof Error
              ? selectIssueWorkflowMutation.error.message
              : String(selectIssueWorkflowMutation.error)}
          </div>
        ) : null}
        {selectedWorkflowQuery.isLoading ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>Loading…</div>
        ) : null}
        {selectedWorkflowQuery.isError ? (
          <div style={{ marginTop: 8, fontSize: 12, color: '#b00' }}>
            {selectedWorkflowQuery.error instanceof Error
              ? selectedWorkflowQuery.error.message
              : String(selectedWorkflowQuery.error)}
          </div>
        ) : null}

        {saveMutation.isError ? (
          <div style={{ marginTop: 8, fontSize: 12, color: '#b00' }}>
            {saveMutation.error instanceof Error ? saveMutation.error.message : String(saveMutation.error)}
          </div>
        ) : null}

        {draftWorkflow ? (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ borderTop: '1px solid #eee', paddingTop: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>Workflow</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  <span style={{ opacity: 0.85 }}>start</span>
                  <input
                    value={workflowSection && typeof workflowSection.start === 'string' ? workflowSection.start : ''}
                    onChange={(e) => setWorkflowField('start', e.target.value)}
                    style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  <span style={{ opacity: 0.85 }}>default_provider</span>
                  <input
                    value={
                      workflowSection && typeof workflowSection.default_provider === 'string'
                        ? workflowSection.default_provider
                        : ''
                    }
                    onChange={(e) => setWorkflowField('default_provider', e.target.value)}
                    placeholder="(optional)"
                    style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
                  />
                </label>
              </div>
            </div>

            {selection?.kind === 'node' ? (
              <div style={{ borderTop: '1px solid #eee', paddingTop: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>Phase: {selection.id}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <span style={{ opacity: 0.85 }}>prompt</span>
                    <input
                      value={selectedPhase && typeof selectedPhase.prompt === 'string' ? selectedPhase.prompt : ''}
                      onChange={(e) => setPhaseField(selection.id, 'prompt', e.target.value)}
                      style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <span style={{ opacity: 0.85 }}>type</span>
                    <input
                      value={selectedPhase && typeof selectedPhase.type === 'string' ? selectedPhase.type : ''}
                      onChange={(e) => setPhaseField(selection.id, 'type', e.target.value)}
                      style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <span style={{ opacity: 0.85 }}>provider</span>
                    <input
                      value={selectedPhase && typeof selectedPhase.provider === 'string' ? selectedPhase.provider : ''}
                      onChange={(e) => setPhaseField(selection.id, 'provider', e.target.value)}
                      placeholder="(optional)"
                      style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <span style={{ opacity: 0.85 }}>description</span>
                    <textarea
                      value={
                        selectedPhase && typeof selectedPhase.description === 'string' ? selectedPhase.description : ''
                      }
                      onChange={(e) => setPhaseField(selection.id, 'description', e.target.value)}
                      rows={3}
                      style={{
                        fontSize: 12,
                        padding: '6px 8px',
                        border: '1px solid #ddd',
                        borderRadius: 6,
                        resize: 'vertical',
                      }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <span style={{ opacity: 0.85 }}>allowed_writes (one per line)</span>
                    <textarea
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
                      style={{
                        fontSize: 12,
                        padding: '6px 8px',
                        border: '1px solid #ddd',
                        borderRadius: 6,
                        resize: 'vertical',
                      }}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {selection?.kind === 'edge' ? (
              <div style={{ borderTop: '1px solid #eee', paddingTop: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
                  Transition: {selection.from} → {selection.to}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={selectedTransition?.auto === true}
                      onChange={(e) => setTransitionField(selection.from, selection.to, 'auto', e.target.checked)}
                    />
                    auto
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <span style={{ opacity: 0.85 }}>when</span>
                    <input
                      value={selectedTransition && typeof selectedTransition.when === 'string' ? selectedTransition.when : ''}
                      onChange={(e) => setTransitionField(selection.from, selection.to, 'when', e.target.value)}
                      placeholder="(optional)"
                      style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                    <span style={{ opacity: 0.85 }}>priority</span>
                    <input
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
                      style={{ fontSize: 12, padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            <details style={{ borderTop: '1px solid #eee', paddingTop: 10 }}>
              <summary style={{ fontSize: 12, cursor: 'pointer', opacity: 0.85 }}>Draft JSON</summary>
              <pre
                style={{
                  marginTop: 8,
                  padding: 8,
                  border: '1px solid #eee',
                  borderRadius: 6,
                  overflow: 'auto',
                  maxHeight: 280,
                  fontSize: 11,
                  lineHeight: 1.4,
                }}
              >
                {JSON.stringify(draftWorkflow, null, 2)}
              </pre>
            </details>
          </div>
        ) : null}
      </section>
    </div>
  );
}
