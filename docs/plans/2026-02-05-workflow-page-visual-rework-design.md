# Workflow Page Visual Rework

**Date:** 2026-02-05
**Status:** Design approved, pending implementation

## Problem

The current workflow page has several UX issues:

1. **D3 force simulation feels like a physics toy** — nodes bounce around, layout never communicates flow direction (start → end). Force-directed graphs are designed for exploring unknown network topologies, not structured DAGs.
2. **Inspector panel is dense** — lots of small form fields stacked vertically, segmented controls wrap awkwardly, hierarchy is hard to scan.
3. **3-panel layout is cramped** — 280px list + 320px inspector leaves little room for the graph, especially on smaller screens.
4. **Page expands to infinity bug** — feedback loop between D3 `forceManyBody` repulsion pushing nodes outward, canvas size growing to accommodate, and ResizeObserver re-syncing the viewBox.

## Design

### Layout: Overlay Panels Over Full-Bleed Graph

The page becomes a **two-zone layout** with overlay panels:

**Center: Graph canvas (always visible, takes full width)**
- React Flow canvas fills the entire page content area
- Dark background matching `--color-bg`
- Controls overlay in bottom-left (zoom in/out, fit view)

**Left: Workflow list sidebar (collapsible)**
- Default state: expanded at ~260px showing workflow names + active badge
- Collapsed state: ~48px wide, shows just a list icon
- Toggle button at the top of the sidebar
- "Create workflow" form at the bottom of the sidebar
- Overlays the graph (absolute/fixed positioning), does not push it

**Right: Inspector panel (contextual slide-out)**
- Hidden when nothing is selected
- Slides in from the right (~340px) when a node or edge is selected
- Close button (X) to dismiss
- Overlays the graph, does not squeeze it
- Contains grouped collapsible cards

**Key property:** The graph never resizes. Panels float over it. No layout thrashing, no ResizeObserver feedback loops.

### Graph: React Flow + Dagre

**Layout algorithm: Dagre (top-to-bottom)**
- Nodes arranged in hierarchical layers — start phase at top, terminal phases at bottom
- Dagre computes positions once when workflow data changes (no continuous simulation)
- Edges route cleanly between layers with proper spacing

**Node design:**
- Rounded rectangle cards (not circles) — more room for the phase name
- Phase name as primary label, phase type as subtle subtitle
- Start phase: distinct accent border (`--color-accent-green`)
- Active phase (from issue): pulsing amber indicator
- Selected node: blue accent border
- Provider/model badge if overridden from workflow defaults

**Edge design:**
- Smooth bezier curves with directional arrows
- Default: subtle muted color (`--color-text-dim`)
- Selected: blue accent, thicker stroke
- Hover: brightens to `--color-text`
- Transition condition (`when`) shown as small label on edge
- Auto-transitions: dashed line style

**Interactions:**
- Click node → select, open inspector with phase editor
- Click edge → select, open inspector with transition editor
- Click canvas → deselect, close inspector
- Drag nodes to adjust positions (React Flow native)
- Scroll to zoom, drag canvas to pan
- "Fit view" button to auto-center

### Inspector: Collapsible Card Sections

**Card 1: Workflow Defaults** (always available when workflow loaded)
- Collapsed by default unless nothing else is selected
- Contains: start phase, default provider, default model, reasoning effort/thinking budget
- Save / Reload / Set Active buttons sticky at top of inspector

**Card 2: Phase Editor** (when node selected)
- Auto-expands on node click
- Header: "Phase: {name}" + Remove button
- Fields: prompt, type, provider override, model override, reasoning/thinking, description, allowed_writes
- "Transitions from {phase}" sub-section with Add Transition button
- Inherited values shown as ghost/hint when not overridden

**Card 3: Transition Editor** (when edge selected)
- Auto-expands on edge click
- Header: "Transition: {from} → {to}" + Remove button
- Fields: target dropdown, auto checkbox, when, priority

**Behavior:**
- Only Card 2 or Card 3 shown at a time (based on selection type)
- Card 1 independently collapsible
- JSON preview as collapsible section at bottom

## Implementation

### Dependencies

**Add:**
- `@xyflow/react` — React Flow v12
- `dagre` + `@types/dagre` — hierarchical DAG layout

**Remove:**
- `d3` — only used in WorkflowGraph.tsx
- `@types/d3` — TypeScript types for d3

### Files Changed

1. **`apps/viewer/package.json`** — swap dependencies
2. **`apps/viewer/src/features/workflows/WorkflowGraph.tsx`** — full rewrite
   - Remove all D3 code (~727 lines)
   - Implement React Flow graph with dagre layout
   - Custom node component (rounded rect with phase info)
   - Custom edge component (bezier with arrow, optional label)
   - Layout computation function using dagre
3. **`apps/viewer/src/pages/WorkflowsPage.tsx`** — layout restructure
   - Replace 3-panel grid with overlay layout
   - Add collapsible sidebar component
   - Add slide-out inspector with card sections
   - All state management and mutation logic stays unchanged
4. **`apps/viewer/src/pages/WorkflowsPage.css`** — full restyle
   - Overlay panel positioning
   - Sidebar collapse/expand transitions
   - Inspector slide-in/out animations
   - Collapsible card styles
   - Remove old 3-panel grid styles

### What Stays the Same

- All API hooks (`useWorkflowsQuery`, `useSaveWorkflowMutation`, etc.)
- All draft state management (`updateDraft`, `setPhaseField`, etc.)
- All CRUD operations (add/remove phase, add/remove transition)
- `constants/workflow.ts` (provider/model definitions)
- Design token system (`tokens.css`)

### Build Sequence

1. Install new deps, remove old deps
2. Rewrite `WorkflowGraph.tsx` with React Flow + dagre
3. Restructure `WorkflowsPage.tsx` layout (sidebar + slide-out inspector)
4. Restyle `WorkflowsPage.css`
5. Verify typecheck, lint, build pass
6. Visual verification in dev server
