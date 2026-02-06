# Workflow Page Visual Rework — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the D3 force-directed workflow graph with React Flow + dagre DAG layout, restructure the page from a cramped 3-panel grid to an overlay layout with collapsible sidebar and slide-out inspector.

**Architecture:** Full-bleed React Flow canvas as the base layer. Workflow list sidebar overlays from the left (collapsible). Inspector panel slides in from the right on selection. Dagre computes hierarchical top-to-bottom layout once per data change — no continuous simulation.

**Tech Stack:** React 18, @xyflow/react (React Flow v12), @dagrejs/dagre, TypeScript, CSS custom properties (design tokens from tokens.css)

**Design doc:** `docs/plans/2026-02-05-workflow-page-visual-rework-design.md`

---

## Context for Implementer

### Project structure
- Monorepo with pnpm workspaces (`apps/*`, `packages/*`)
- Viewer app: `apps/viewer/` — React + Vite + TypeScript
- Quality commands (run from repo root):
  - `pnpm typecheck` — TypeScript project references build
  - `pnpm lint` — ESLint, zero warnings allowed
  - `pnpm test` — Vitest
  - `pnpm --filter @jeeves/viewer build` — Vite production build

### Design token rules (from `apps/viewer/CLAUDE.md`)
- All colors via `var(--color-*)` tokens from `src/styles/tokens.css`
- No hex colors outside tokens.css
- RGBA overlays allowed for transparency (e.g. `rgba(88, 166, 255, 0.15)`)
- No `color-mix()`

### Files we're changing
| File | Action |
|------|--------|
| `apps/viewer/package.json` | Add @xyflow/react, @dagrejs/dagre, @types/dagre; remove d3, @types/d3 |
| `apps/viewer/src/features/workflows/WorkflowGraph.tsx` | Full rewrite (727→~250 lines) |
| `apps/viewer/src/pages/WorkflowsPage.tsx` | Layout restructure (1164 lines, keep all logic) |
| `apps/viewer/src/pages/WorkflowsPage.css` | Full restyle |

### Files we're NOT changing
- `src/api/workflows.ts` — API hooks stay identical
- `src/constants/workflow.ts` — provider/model config stays identical
- `src/app/router.tsx` — route stays identical
- `src/styles/tokens.css` — tokens stay identical
- `src/layout/AppShell.tsx` — shell layout stays identical

### Key type: WorkflowGraphSelection (keep this interface)
```typescript
export type WorkflowGraphSelection =
  | Readonly<{ kind: 'node'; id: string }>
  | Readonly<{ kind: 'edge'; from: string; to: string }>
  | null;
```

---

## Task 1: Swap Dependencies

**Files:**
- Modify: `apps/viewer/package.json`

**Step 1: Install new dependencies**

Run from repo root:
```bash
cd apps/viewer && pnpm add @xyflow/react @dagrejs/dagre && pnpm add -D @types/dagre
```

**Step 2: Remove old dependencies**

```bash
cd apps/viewer && pnpm remove d3 @types/d3
```

**Step 3: Verify install**

```bash
pnpm install && pnpm typecheck
```

Expected: typecheck will FAIL because WorkflowGraph.tsx still imports d3. That's fine — we'll fix it in Task 2.

**Step 4: Commit**

```bash
git add apps/viewer/package.json pnpm-lock.yaml
git commit -m "chore: swap d3 for @xyflow/react and dagre"
```

---

## Task 2: Rewrite WorkflowGraph.tsx

**Files:**
- Rewrite: `apps/viewer/src/features/workflows/WorkflowGraph.tsx`

This is the biggest task. Replace 727 lines of D3 force simulation with React Flow + dagre.

**Step 1: Write the new WorkflowGraph component**

Replace the entire contents of `apps/viewer/src/features/workflows/WorkflowGraph.tsx` with:

```tsx
import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type OnSelectionChangeFunc,
  MarkerType,
  Position,
  Handle,
  BaseEdge,
  getBezierPath,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';

// Re-export selection type so WorkflowsPage.tsx import stays the same
export type WorkflowGraphSelection =
  | Readonly<{ kind: 'node'; id: string }>
  | Readonly<{ kind: 'edge'; from: string; to: string }>
  | null;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/*  Dagre layout                                                      */
/* ------------------------------------------------------------------ */

const NODE_WIDTH = 180;
const NODE_HEIGHT = 64;

function getLayoutedElements(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
    };
  });

  return { nodes: layoutedNodes, edges };
}

/* ------------------------------------------------------------------ */
/*  Custom node                                                       */
/* ------------------------------------------------------------------ */

interface PhaseNodeData {
  label: string;
  phaseType: string;
  isStart: boolean;
  isActive: boolean;
  hasOverrides: boolean;
  [key: string]: unknown;
}

function PhaseNode({ data, selected }: { data: PhaseNodeData; selected?: boolean }) {
  const borderColor = data.isActive
    ? 'var(--color-accent-amber)'
    : data.isStart
      ? 'var(--color-accent-green)'
      : selected
        ? 'var(--color-accent-blue)'
        : 'var(--color-border)';

  const bgColor = selected ? 'var(--color-surface-2)' : 'var(--color-surface-1)';

  return (
    <div
      className="wf-graph-node"
      style={{
        background: bgColor,
        borderColor,
        borderWidth: data.isActive || data.isStart || selected ? 2 : 1,
      }}
    >
      <Handle type="target" position={Position.Top} className="wf-graph-handle" />
      <div className="wf-graph-node-label">{data.label}</div>
      <div className="wf-graph-node-sub">{data.phaseType}</div>
      {data.hasOverrides && <div className="wf-graph-node-badge" />}
      {data.isActive && <div className="wf-graph-node-active-dot" />}
      <Handle type="source" position={Position.Bottom} className="wf-graph-handle" />
    </div>
  );
}

const nodeTypes: NodeTypes = { phase: PhaseNode };

/* ------------------------------------------------------------------ */
/*  Custom edge                                                       */
/* ------------------------------------------------------------------ */

interface TransitionEdgeData {
  label?: string;
  isAuto?: boolean;
  count?: number;
  [key: string]: unknown;
}

function TransitionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  selected?: boolean;
  data?: TransitionEdgeData;
}) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const stroke = selected ? 'var(--color-accent-blue)' : 'var(--color-text-dim)';
  const strokeWidth = selected ? 2.5 : 1.5;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke,
          strokeWidth,
          strokeDasharray: data?.isAuto ? '6 3' : undefined,
        }}
      />
      {data?.label && (
        <foreignObject
          x={labelX - 40}
          y={labelY - 10}
          width={80}
          height={20}
          className="wf-graph-edge-label-fo"
        >
          <div className="wf-graph-edge-label">{data.label}</div>
        </foreignObject>
      )}
      {(data?.count ?? 1) > 1 && (
        <foreignObject
          x={labelX - 10}
          y={labelY - 10}
          width={20}
          height={20}
          className="wf-graph-edge-badge-fo"
        >
          <div className="wf-graph-edge-badge">{data?.count}</div>
        </foreignObject>
      )}
    </>
  );
}

const edgeTypes: EdgeTypes = { transition: TransitionEdge };

/* ------------------------------------------------------------------ */
/*  Parse workflow → React Flow nodes/edges                           */
/* ------------------------------------------------------------------ */

function workflowToElements(
  workflow: Record<string, unknown>,
  currentPhaseId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const wfSection = isRecord(workflow.workflow) ? workflow.workflow : {};
  const phasesRaw = isRecord(workflow.phases) ? workflow.phases : {};
  const startPhase = typeof wfSection.start === 'string' ? wfSection.start : undefined;

  const nodes: Node[] = Object.keys(phasesRaw)
    .sort()
    .map((id) => {
      const phase = isRecord(phasesRaw[id]) ? (phasesRaw[id] as Record<string, unknown>) : {};
      const hasOverrides = typeof phase.provider === 'string' || typeof phase.model === 'string';
      return {
        id,
        type: 'phase',
        position: { x: 0, y: 0 }, // dagre will set this
        data: {
          label: id,
          phaseType: typeof phase.type === 'string' ? phase.type : 'execute',
          isStart: id === startPhase,
          isActive: id === currentPhaseId,
          hasOverrides,
        } satisfies PhaseNodeData,
      };
    });

  // Collapse duplicate from→to into a single edge with count
  const edgeCounts = new Map<string, { from: string; to: string; count: number; hasAuto: boolean; when: string | undefined }>();

  for (const [from, phaseRaw] of Object.entries(phasesRaw)) {
    if (!isRecord(phaseRaw)) continue;
    const transitions = phaseRaw.transitions;
    if (!Array.isArray(transitions)) continue;
    for (const t of transitions) {
      if (!isRecord(t)) continue;
      const to = t.to;
      if (typeof to !== 'string' || !to.trim()) continue;
      const key = `${from}→${to}`;
      const prev = edgeCounts.get(key);
      if (prev) {
        prev.count += 1;
      } else {
        edgeCounts.set(key, {
          from,
          to,
          count: 1,
          hasAuto: t.auto === true,
          when: typeof t.when === 'string' ? t.when : undefined,
        });
      }
    }
  }

  const edges: Edge[] = Array.from(edgeCounts.entries()).map(([key, v]) => ({
    id: key,
    source: v.from,
    target: v.to,
    type: 'transition',
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-text-dim)', width: 16, height: 16 },
    data: {
      label: v.when,
      isAuto: v.hasAuto,
      count: v.count,
    } satisfies TransitionEdgeData,
  }));

  return getLayoutedElements(nodes, edges);
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

function WorkflowGraphInner(props: Readonly<{
  workflow: Record<string, unknown> | null;
  currentPhaseId: string | null;
  selection: WorkflowGraphSelection;
  onSelectionChange: (next: WorkflowGraphSelection) => void;
}>) {
  const { fitView } = useReactFlow();

  const { nodes, edges } = useMemo(() => {
    if (!props.workflow) return { nodes: [], edges: [] };
    return workflowToElements(props.workflow, props.currentPhaseId);
  }, [props.workflow, props.currentPhaseId]);

  // Derive selected node/edge IDs for React Flow
  const selectedNodeIds = useMemo(() => {
    if (props.selection?.kind === 'node') return new Set([props.selection.id]);
    return new Set<string>();
  }, [props.selection]);

  const selectedEdgeIds = useMemo(() => {
    if (props.selection?.kind === 'edge') return new Set([`${props.selection.from}→${props.selection.to}`]);
    return new Set<string>();
  }, [props.selection]);

  // Apply selection state to nodes/edges
  const nodesWithSelection = useMemo(
    () => nodes.map((n) => ({ ...n, selected: selectedNodeIds.has(n.id) })),
    [nodes, selectedNodeIds],
  );

  const edgesWithSelection = useMemo(
    () => edges.map((e) => ({ ...e, selected: selectedEdgeIds.has(e.id) })),
    [edges, selectedEdgeIds],
  );

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selNodes, edges: selEdges }) => {
      if (selNodes.length > 0) {
        props.onSelectionChange({ kind: 'node', id: selNodes[0].id });
      } else if (selEdges.length > 0) {
        const edge = selEdges[0];
        props.onSelectionChange({ kind: 'edge', from: edge.source, to: edge.target });
      } else {
        props.onSelectionChange(null);
      }
    },
    [props.onSelectionChange],
  );

  const onPaneClick = useCallback(() => {
    props.onSelectionChange(null);
  }, [props.onSelectionChange]);

  // Fit view when layout changes
  const onNodesChange = useCallback(() => {
    // Let React Flow handle internal state; we only use controlled selection
  }, []);

  return (
    <ReactFlow
      nodes={nodesWithSelection}
      edges={edgesWithSelection}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onSelectionChange={onSelectionChange}
      onPaneClick={onPaneClick}
      onInit={() => fitView({ padding: 0.2 })}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable={true}
      nodesConnectable={false}
      elementsSelectable={true}
      selectNodesOnDrag={false}
      panOnScroll={false}
      minZoom={0.2}
      maxZoom={3}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background color="var(--color-border-subtle)" gap={20} size={1} />
      <Controls
        showInteractive={false}
        position="bottom-left"
        className="wf-graph-controls"
      />
    </ReactFlow>
  );
}

export function WorkflowGraph(props: Readonly<{
  workflow: Record<string, unknown> | null;
  currentPhaseId: string | null;
  selection: WorkflowGraphSelection;
  onSelectionChange: (next: WorkflowGraphSelection) => void;
}>) {
  return (
    <ReactFlowProvider>
      <WorkflowGraphInner {...props} />
    </ReactFlowProvider>
  );
}
```

**Step 2: Verify typecheck passes**

```bash
pnpm typecheck
```

Expected: Should pass (or have only CSS-related issues we fix in Task 4).

**Step 3: Commit**

```bash
git add apps/viewer/src/features/workflows/WorkflowGraph.tsx
git commit -m "feat: rewrite workflow graph with React Flow + dagre layout"
```

---

## Task 3: Restructure WorkflowsPage.tsx Layout

**Files:**
- Modify: `apps/viewer/src/pages/WorkflowsPage.tsx`

Keep ALL state management, API hooks, draft mutation logic, CRUD operations. Only change the JSX structure from 3-panel grid to overlay layout with collapsible sidebar + slide-out inspector.

**Step 1: Add sidebar/inspector state and restructure JSX**

At the top of `WorkflowsPage`, add state for sidebar collapse:

```typescript
const [sidebarOpen, setSidebarOpen] = useState(true);
```

The inspector visibility is derived: it's open whenever `selection` is non-null OR when we want to show workflow defaults.

Replace the return JSX with the new overlay layout structure:

```tsx
return (
  <div className="wf-container">
    {/* Full-bleed graph canvas */}
    <div className="wf-graph-canvas">
      <WorkflowGraph
        workflow={draftWorkflow ?? selectedRawWorkflow}
        currentPhaseId={currentIssuePhase}
        selection={selection}
        onSelectionChange={setSelection}
      />
    </div>

    {/* Collapsible sidebar overlay */}
    <aside className={`wf-sidebar ${sidebarOpen ? 'open' : 'collapsed'}`}>
      <div className="wf-sidebar-header">
        <button
          className="wf-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {sidebarOpen ? '\u2190' : '\u2192'}
        </button>
        {sidebarOpen && <h2 className="wf-sidebar-title">Workflows</h2>}
      </div>

      {sidebarOpen && (
        <>
          {/* ... workflow list content (same as before) ... */}
        </>
      )}
    </aside>

    {/* Slide-out inspector overlay */}
    {(selection || draftWorkflow) && (
      <aside className={`wf-inspector ${selection ? 'open' : ''}`}>
        {/* ... inspector content with collapsible cards ... */}
      </aside>
    )}
  </div>
);
```

The detailed JSX for the sidebar keeps the existing workflow list items, create form, issue ref, and refresh button — just wrapped in the new sidebar structure.

The inspector reorganizes existing form fields into collapsible card sections:
- `<details>` elements for each card (Workflow Defaults, Phase Editor, Transition Editor)
- Card 2/3 use `open` attribute controlled by selection type
- Sticky action bar at top with Save/Reload/Set Active

**Step 2: Verify typecheck passes**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add apps/viewer/src/pages/WorkflowsPage.tsx
git commit -m "feat: restructure workflow page to overlay layout with collapsible sidebar"
```

---

## Task 4: Restyle WorkflowsPage.css

**Files:**
- Rewrite: `apps/viewer/src/pages/WorkflowsPage.css`

Replace the entire CSS file. Key sections:

1. **Container** — `position: relative; width: 100%; height: calc(100vh - 160px);` (no grid)
2. **Graph canvas** — `position: absolute; inset: 0;` fills container
3. **Sidebar** — `position: absolute; left: 0; top: 0; bottom: 0; width: 260px;` with transition on width. Collapsed: `width: 48px;`
4. **Inspector** — `position: absolute; right: 0; top: 0; bottom: 0; width: 340px; transform: translateX(100%);` with transition. Open: `transform: translateX(0);`
5. **Cards** — `<details>` styling with summary as card headers
6. **Graph node** — `.wf-graph-node` rounded rect with token colors
7. **Graph edge label** — `.wf-graph-edge-label` small text badge
8. **React Flow overrides** — dark theme color overrides for React Flow's built-in controls

All colors MUST use design tokens. No hex values. RGBA overlays allowed for transparencies.

**Step 1: Write the new CSS**

Replace the entire contents of `apps/viewer/src/pages/WorkflowsPage.css`. Key style rules to include:

```css
/* Container — relative positioned so overlays can use absolute */
.wf-container {
  position: relative;
  width: 100%;
  height: calc(100vh - 120px);
  background: var(--color-bg);
  font-family: var(--font-sans);
  overflow: hidden;
}

/* Graph canvas fills everything */
.wf-graph-canvas {
  position: absolute;
  inset: 0;
}

/* Sidebar overlay */
.wf-sidebar {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 260px;
  background: var(--color-surface-1);
  border-right: 1px solid var(--color-border);
  transition: width 0.2s ease;
  overflow: hidden;
  z-index: 10;
  display: flex;
  flex-direction: column;
}

.wf-sidebar.collapsed { width: 48px; }

/* Inspector slide-out */
.wf-inspector {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 340px;
  background: var(--color-surface-1);
  border-left: 1px solid var(--color-border);
  transform: translateX(100%);
  transition: transform 0.25s ease;
  overflow-y: auto;
  z-index: 10;
}

.wf-inspector.open { transform: translateX(0); }

/* Graph node (custom React Flow node) */
.wf-graph-node {
  padding: 10px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  min-width: 140px;
  text-align: center;
}

.wf-graph-node-label {
  font-size: var(--font-size-ui-sm);
  font-weight: 600;
  color: var(--color-text);
}

.wf-graph-node-sub {
  font-size: var(--font-size-ui-xs);
  color: var(--color-text-dim);
  margin-top: 2px;
}
```

Plus: all existing form field styles (`.wf-btn`, `.wf-input`, `.wf-seg-row`, etc.) carried over with minor adjustments for the new panel widths.

**Step 2: Verify build passes**

```bash
pnpm --filter @jeeves/viewer build
```

**Step 3: Commit**

```bash
git add apps/viewer/src/pages/WorkflowsPage.css
git commit -m "feat: restyle workflow page with overlay panels and graph node styles"
```

---

## Task 5: Quality Verification

**Step 1: Full typecheck**

```bash
pnpm typecheck
```

Expected: PASS, zero errors.

**Step 2: Lint**

```bash
pnpm lint
```

Expected: PASS, zero warnings.

**Step 3: Test**

```bash
pnpm test
```

Expected: All existing tests pass. No workflow-specific tests exist currently.

**Step 4: Production build**

```bash
pnpm --filter @jeeves/viewer build
```

Expected: PASS, clean build.

**Step 5: Commit any fixes**

If any step above required changes, commit them:

```bash
git add -A && git commit -m "fix: address lint/typecheck issues from workflow page rework"
```

---

## Task 6: Visual Verification & Polish

**Step 1: Start dev server**

```bash
pnpm dev
```

Open `http://localhost:8080/workflows` in the browser.

**Step 2: Verify checklist**

- [ ] Graph renders with top-to-bottom dagre layout
- [ ] Nodes show phase name + type
- [ ] Start phase has green border
- [ ] Edges show directional arrows
- [ ] Auto-transitions show dashed lines
- [ ] Click node → inspector slides in with phase editor
- [ ] Click edge → inspector shows transition editor
- [ ] Click canvas → inspector slides out
- [ ] Sidebar toggle collapses/expands
- [ ] Workflow list works (select, create, refresh)
- [ ] Save/Reload/Set Active work
- [ ] Provider/model segmented controls work
- [ ] Add Phase / Add Transition work
- [ ] Remove Phase / Remove Transition work
- [ ] JSON preview works
- [ ] Page does NOT expand infinitely
- [ ] Zoom/pan work smoothly
- [ ] Dark theme consistent throughout

**Step 3: Fix any visual issues found**

Address each issue, commit separately.

**Step 4: Final commit**

```bash
git add -A && git commit -m "polish: workflow page visual refinements"
```
