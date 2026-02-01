import { useEffect, useMemo, useState } from 'react';

import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useWorkflowByNameQuery, useWorkflowsQuery } from '../api/workflows.js';
import { WorkflowGraph, type WorkflowGraphSelection } from '../features/workflows/WorkflowGraph.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';

export function WorkflowsPage() {
  const baseUrl = useViewerServerBaseUrl();
  const stream = useViewerStream();

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

  useEffect(() => {
    if (!issueWorkflow) return;
    setSelectedName(issueWorkflow);
  }, [issueWorkflow]);

  useEffect(() => {
    if (selectedName) return;
    if (workflows.length === 0) return;
    setSelectedName(workflows[0].name);
  }, [selectedName, workflows]);

  const selectedWorkflowQuery = useWorkflowByNameQuery(baseUrl, selectedName);
  const selectedRawWorkflow = selectedWorkflowQuery.data?.workflow ?? null;

  useEffect(() => {
    setSelection(null);
  }, [selectedName]);

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
              onClick={() => setSelectedName(w.name)}
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
        <h2 style={{ margin: 0, fontSize: 14 }}>Inspector</h2>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
          Selected: {selectedName ? selectedName : '(none)'}
        </div>
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
          Selection:{' '}
          {selection?.kind === 'node'
            ? `phase ${selection.id}`
            : selection?.kind === 'edge'
              ? `transition ${selection.from} → ${selection.to}`
              : '(none)'}
        </div>
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
        {selectedWorkflowQuery.data ? (
          <pre
            style={{
              marginTop: 8,
              padding: 8,
              border: '1px solid #eee',
              borderRadius: 6,
              overflow: 'auto',
              maxHeight: 360,
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            {selectedWorkflowQuery.data.yaml}
          </pre>
        ) : null}
      </section>
    </div>
  );
}
