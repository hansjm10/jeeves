import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  MarkerType,
  useReactFlow,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeProps,
  type EdgeProps,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';

import '@xyflow/react/dist/style.css';

// ---------------------------------------------------------------------------
// Public types (kept identical to the old D3 implementation)
// ---------------------------------------------------------------------------

export type WorkflowGraphSelection =
  | Readonly<{ kind: 'node'; id: string }>
  | Readonly<{ kind: 'edge'; from: string; to: string }>
  | null;

// ---------------------------------------------------------------------------
// Internal data types carried by React Flow nodes and edges
// ---------------------------------------------------------------------------

type PhaseNodeData = {
  label: string;
  phaseType: string;
  isStart: boolean;
  isActive: boolean;
  provider?: string;
  model?: string;
};

type TransitionEdgeData = {
  count: number;
  isAuto: boolean;
  when?: string;
};

type PhaseNode = RFNode<PhaseNodeData, 'phase'>;
type TransitionEdge = RFEdge<TransitionEdgeData, 'transition'>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// workflowToElements  --  parse workflow JSON into React Flow nodes/edges
// ---------------------------------------------------------------------------

const NODE_WIDTH = 200;
const NODE_HEIGHT = 72;

function workflowToElements(
  workflow: Record<string, unknown>,
): { nodes: PhaseNode[]; edges: TransitionEdge[] } | null {
  const phasesRaw = workflow.phases;
  if (!isRecord(phasesRaw)) return null;

  const wfSection = isRecord(workflow.workflow) ? workflow.workflow : {};
  const startPhase = typeof wfSection.start === 'string' ? wfSection.start : null;

  // Build dagre graph
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  const phaseIds = Object.keys(phasesRaw).sort();

  for (const id of phaseIds) {
    g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Collapse duplicate transitions (same from -> to) into single edges with count
  const edgeCounts = new Map<
    string,
    {
      from: string;
      to: string;
      count: number;
      isAuto: boolean;
      when?: string;
    }
  >();

  for (const [from, phaseRaw] of Object.entries(phasesRaw)) {
    if (!isRecord(phaseRaw)) continue;
    const transitions = phaseRaw.transitions;
    if (!Array.isArray(transitions)) continue;
    for (const t of transitions) {
      if (!isRecord(t)) continue;
      const to = t.to;
      if (typeof to !== 'string' || !to.trim()) continue;
      const key = `${from}->${to}`;
      const prev = edgeCounts.get(key);
      if (prev) {
        prev.count += 1;
      } else {
        edgeCounts.set(key, {
          from,
          to,
          count: 1,
          isAuto: t.auto === true,
          when: typeof t.when === 'string' ? t.when : undefined,
        });
      }
    }
  }

  for (const { from, to } of edgeCounts.values()) {
    // Only add dagre edge if both endpoints exist
    if (g.hasNode(from) && g.hasNode(to)) {
      g.setEdge(from, to);
    }
  }

  // Run dagre layout
  dagre.layout(g);

  // Convert to React Flow nodes
  const nodes: PhaseNode[] = phaseIds.map((id) => {
    const pos = g.node(id);
    const phaseRaw = phasesRaw[id];
    const phase = isRecord(phaseRaw) ? phaseRaw : {};
    return {
      id,
      type: 'phase' as const,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: {
        label: id,
        phaseType: typeof phase.type === 'string' ? phase.type : 'unknown',
        isStart: id === startPhase,
        isActive: false, // set by caller via currentPhaseId
        provider: typeof phase.provider === 'string' ? phase.provider : undefined,
        model: typeof phase.model === 'string' ? phase.model : undefined,
      },
    };
  });

  // Convert to React Flow edges
  const edges: TransitionEdge[] = Array.from(edgeCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, info]) => ({
      id: key,
      type: 'transition' as const,
      source: info.from,
      target: info.to,
      sourceHandle: 'bottom',
      targetHandle: 'top',
      data: {
        count: info.count,
        isAuto: info.isAuto,
        when: info.when,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: 'var(--color-text-dim)',
      },
    }));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// PhaseNode custom component
// ---------------------------------------------------------------------------

function PhaseNodeComponent({ data, selected }: NodeProps<PhaseNode>) {
  const borderColor = selected
    ? 'var(--color-accent-blue)'
    : data.isActive
      ? 'var(--color-accent-amber)'
      : data.isStart
        ? 'var(--color-accent-green)'
        : 'var(--color-border)';

  const borderWidth = selected || data.isActive || data.isStart ? 2 : 1;

  return (
    <div
      style={{
        background: selected ? 'var(--color-surface-2)' : 'var(--color-surface-1)',
        border: `${borderWidth}px solid ${borderColor}`,
        borderRadius: 'var(--radius-md)',
        padding: '10px 14px',
        minWidth: 160,
        fontFamily: 'var(--font-sans)',
        color: 'var(--color-text)',
        cursor: 'grab',
      }}
    >
      <Handle type="target" position={Position.Top} id="top" style={{ background: 'var(--color-border)' }} />

      <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, marginBottom: 2 }}>
        {data.label}
      </div>
      <div style={{ fontSize: 'var(--font-size-ui-xs)', color: 'var(--color-text-muted)' }}>
        {data.phaseType}
      </div>

      {(data.provider || data.model) && (
        <div
          style={{
            marginTop: 6,
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
          }}
        >
          {data.provider && (
            <span
              style={{
                fontSize: 'var(--font-size-ui-xs)',
                background: 'var(--color-surface-inset)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '1px 6px',
                color: 'var(--color-text-muted)',
              }}
            >
              {data.provider}
            </span>
          )}
          {data.model && (
            <span
              style={{
                fontSize: 'var(--font-size-ui-xs)',
                background: 'var(--color-surface-inset)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)',
                padding: '1px 6px',
                color: 'var(--color-text-muted)',
              }}
            >
              {data.model}
            </span>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: 'var(--color-border)' }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TransitionEdge custom component
// ---------------------------------------------------------------------------

function TransitionEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<TransitionEdge>) {
  const strokeColor = selected ? 'var(--color-accent-blue)' : 'var(--color-text-dim)';
  const strokeWidth = selected ? 3 : 2;
  const strokeDasharray = data?.isAuto ? '6 3' : undefined;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const hasLabel = (data?.when && data.when.trim()) || (data?.count ?? 1) > 1;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth,
          strokeDasharray,
        }}
      />
      {hasLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'none',
              display: 'flex',
              gap: 4,
              alignItems: 'center',
            }}
          >
            {data?.when && data.when.trim() && (
              <span
                style={{
                  fontSize: 'var(--font-size-ui-xs)',
                  color: selected ? 'var(--color-accent-blue)' : 'var(--color-text-muted)',
                  background: 'var(--color-surface-1)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '1px 5px',
                  whiteSpace: 'nowrap',
                }}
              >
                {data.when}
              </span>
            )}
            {(data?.count ?? 1) > 1 && (
              <span
                style={{
                  fontSize: 'var(--font-size-ui-xs)',
                  color: selected ? 'var(--color-accent-blue)' : 'var(--color-text)',
                  background: 'var(--color-surface-inset)',
                  border: `1px solid ${selected ? 'var(--color-accent-blue)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-pill)',
                  padding: '0px 6px',
                  minWidth: 18,
                  textAlign: 'center',
                  lineHeight: '18px',
                }}
              >
                {data?.count}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Node and Edge type maps (stable references, defined OUTSIDE component)
// ---------------------------------------------------------------------------

const nodeTypes = { phase: PhaseNodeComponent };
const edgeTypes = { transition: TransitionEdgeComponent };

// ---------------------------------------------------------------------------
// Inner graph component (must live inside ReactFlowProvider)
// ---------------------------------------------------------------------------

function WorkflowGraphInner(props: Readonly<{
  workflow: Record<string, unknown> | null;
  currentPhaseId: string | null;
  selection: WorkflowGraphSelection;
  onSelectionChange: (next: WorkflowGraphSelection) => void;
}>) {
  const reactFlowInstance = useReactFlow();

  // Parse workflow into nodes + edges, applying currentPhaseId
  const elements = useMemo(() => {
    if (!props.workflow) return null;
    const result = workflowToElements(props.workflow);
    if (!result) return null;

    // Apply currentPhaseId to node data
    if (props.currentPhaseId) {
      for (const node of result.nodes) {
        if (node.id === props.currentPhaseId) {
          node.data = { ...node.data, isActive: true };
        }
      }
    }

    return result;
  }, [props.workflow, props.currentPhaseId]);

  // Apply selection state to nodes and edges
  const nodes = useMemo(() => {
    if (!elements) return [];
    return elements.nodes.map((node) => ({
      ...node,
      selected: props.selection?.kind === 'node' && props.selection.id === node.id,
    }));
  }, [elements, props.selection]);

  const edges = useMemo(() => {
    if (!elements) return [];
    return elements.edges.map((edge) => {
      const isSelected =
        props.selection?.kind === 'edge' &&
        props.selection.from === edge.source &&
        props.selection.to === edge.target;
      return {
        ...edge,
        selected: isSelected,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: isSelected ? 'var(--color-accent-blue)' : 'var(--color-text-dim)',
        },
      };
    });
  }, [elements, props.selection]);

  // Map React Flow selection changes to our WorkflowGraphSelection type
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }) => {
      if (selectedNodes.length > 0) {
        props.onSelectionChange({ kind: 'node', id: selectedNodes[0].id });
      } else if (selectedEdges.length > 0) {
        const edge = selectedEdges[0];
        props.onSelectionChange({ kind: 'edge', from: edge.source, to: edge.target });
      }
      // Dispatch null when both arrays are empty (e.g. Escape key, programmatic
      // deselection) so the parent selection state stays in sync.
      else {
        props.onSelectionChange(null);
      }
    },
    [props.onSelectionChange],
  );

  // Click on pane = deselect
  const onPaneClick = useCallback(() => {
    props.onSelectionChange(null);
  }, [props.onSelectionChange]);

  // Fit view once nodes are initialized.
  // The `fitView` prop handles the initial fit; onInit nudges it after React
  // Flow finishes its internal node-measurement pass (requestAnimationFrame
  // aligns with the next paint, avoiding a fragile fixed-ms timeout).
  const onInit = useCallback(() => {
    requestAnimationFrame(() => {
      reactFlowInstance.fitView({ padding: 0.15 });
    });
  }, [reactFlowInstance]);

  if (!elements) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--font-size-ui-sm)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        No workflow graph data.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onSelectionChange={onSelectionChange}
      onPaneClick={onPaneClick}
      onInit={onInit}
      colorMode="dark"
      fitView
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      selectNodesOnDrag={false}
      panOnScroll={false}
      minZoom={0.2}
      maxZoom={3}
      defaultEdgeOptions={{
        type: 'transition',
      }}
    >
      <Background color="var(--color-border-subtle)" gap={20} size={1} />
      <Controls />
    </ReactFlow>
  );
}

// ---------------------------------------------------------------------------
// Public component (wraps in ReactFlowProvider)
// ---------------------------------------------------------------------------

export function WorkflowGraph(props: Readonly<{
  workflow: Record<string, unknown> | null;
  currentPhaseId: string | null;
  selection: WorkflowGraphSelection;
  onSelectionChange: (next: WorkflowGraphSelection) => void;
}>) {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlowProvider>
        <WorkflowGraphInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
