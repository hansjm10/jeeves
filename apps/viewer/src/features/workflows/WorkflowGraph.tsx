import { useEffect, useMemo, useRef, useCallback } from 'react';
import * as d3 from 'd3';

/**
 * Get a CSS custom property value from :root. Allows D3 SVG code to use
 * the same design tokens defined in tokens.css.
 */
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Graph color palette derived from design tokens.
 * Values are resolved lazily at render time to respect theme changes.
 */
function getGraphColors() {
  return {
    // Backgrounds
    nodeFill: getCssVar('--color-surface-1'),
    nodeFillSelected: getCssVar('--color-surface-2'),
    badgeFill: getCssVar('--color-surface-inset'),
    // Borders
    border: getCssVar('--color-border'),
    borderSubtle: getCssVar('--color-border-subtle'),
    // Text
    text: getCssVar('--color-text'),
    textMuted: getCssVar('--color-text-muted'),
    // Accents
    accentBlue: getCssVar('--color-accent-blue'),
    accentAmber: getCssVar('--color-accent-amber'),
  };
}

export type WorkflowGraphSelection =
  | Readonly<{ kind: 'node'; id: string }>
  | Readonly<{ kind: 'edge'; from: string; to: string }>
  | null;

type GraphNode = d3.SimulationNodeDatum & Readonly<{ id: string; label: string }> & {
  pinned?: boolean;
};
type GraphLink = d3.SimulationLinkDatum<GraphNode> & {
  readonly id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  /** Number of transitions represented by this edge (collapsed by from→to). */
  count?: number;
  /** True if both from→to and to→from exist. */
  isBidirectional?: boolean;
  /** Cached label anchor, recomputed on tick. */
  _labelX?: number;
  _labelY?: number;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function parseWorkflowGraph(workflow: Record<string, unknown>): { nodes: GraphNode[]; links: GraphLink[] } | null {
  const phasesRaw = workflow.phases;
  if (!isRecord(phasesRaw)) return null;

  const nodes: GraphNode[] = Object.keys(phasesRaw)
    .sort()
    .map((id) => ({ id, label: id }));

  // Collapse multiple transitions with the same from→to into a single rendered edge.
  const linkCounts = new Map<string, { from: string; to: string; count: number }>();

  for (const [from, phaseRaw] of Object.entries(phasesRaw)) {
    if (!isRecord(phaseRaw)) continue;
    const transitions = phaseRaw.transitions;
    if (!Array.isArray(transitions)) continue;
    for (const t of transitions) {
      if (!isRecord(t)) continue;
      const to = t.to;
      if (typeof to !== 'string' || !to.trim()) continue;
      const key = `${from}→${to}`;
      const prev = linkCounts.get(key);
      if (prev) prev.count += 1;
      else linkCounts.set(key, { from, to, count: 1 });
    }
  }

  const links: GraphLink[] = Array.from(linkCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ id: key, source: v.from, target: v.to, count: v.count }));

  return { nodes, links };
}

function getLinkEndpointId(v: string | GraphNode): string {
  return typeof v === 'string' ? v : v.id;
}

function getViewportSize(svgEl: SVGSVGElement): { width: number; height: number } {
  // Prefer bounding box since CSS often sets width/height via %.
  const rect = svgEl.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width || svgEl.clientWidth || 0) || 900);
  const height = Math.max(1, Math.floor(rect.height || svgEl.clientHeight || 0) || 520);
  return { width, height };
}

export function WorkflowGraph(props: Readonly<{
  workflow: Record<string, unknown> | null;
  currentPhaseId: string | null;
  selection: WorkflowGraphSelection;
  onSelectionChange: (next: WorkflowGraphSelection) => void;
}>) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Refs for persisting state across renders
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const nodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const pinnedNodeIdsRef = useRef<Set<string>>(new Set());
  const lastDragEndedAtRef = useRef<number>(0);
  const dragStartRef = useRef<Map<string, { x: number; y: number; wasPinned: boolean }>>(new Map());
  const linksGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodesGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const viewportGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const hasUserZoomedRef = useRef(false);
  const canvasSizeRef = useRef<{ width: number; height: number } | null>(null);
  const nodesDataRef = useRef<GraphNode[]>([]);
  const linksDataRef = useRef<GraphLink[]>([]);

  // Ref to store the previous graph for structural comparison
  const prevGraphRef = useRef<{ nodes: GraphNode[]; links: GraphLink[] } | null>(null);

  const graph = useMemo(() => {
    if (!props.workflow) {
      prevGraphRef.current = null;
      return null;
    }
    const newGraph = parseWorkflowGraph(props.workflow);
    if (!newGraph) {
      prevGraphRef.current = null;
      return null;
    }

    // Compare with previous graph - only update if structure changed
    const prev = prevGraphRef.current;
    if (prev) {
      // Compare node IDs
      const prevNodeIds = prev.nodes.map((n) => n.id).join(',');
      const newNodeIds = newGraph.nodes.map((n) => n.id).join(',');
      // Compare link signatures
      const prevLinkSigs = prev.links.map((l) => l.id).join(',');
      const newLinkSigs = newGraph.links.map((l) => l.id).join(',');

      if (prevNodeIds === newNodeIds && prevLinkSigs === newLinkSigs) {
        // Structure unchanged, return previous reference to avoid simulation reset
        return prev;
      }
    }

    // Structure changed, update ref and return new graph
    prevGraphRef.current = newGraph;
    return newGraph;
  }, [props.workflow]);

  // Memoize selection check functions to avoid recreating on every render
  const isSelectedNode = useCallback((id: string) =>
    props.selection?.kind === 'node' && props.selection.id === id,
    [props.selection]
  );

  const isSelectedEdge = useCallback((from: string, to: string) =>
    props.selection?.kind === 'edge' && props.selection.from === from && props.selection.to === to,
    [props.selection]
  );

  // Effect 1: Setup simulation when graph structure changes
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    // Resolve design tokens for this render pass
    const colors = getGraphColors();

    // Keep rendering scale stable across screen sizes by making the SVG coordinate system
    // match the actual viewport size (1 SVG unit == 1 CSS pixel). We then lay out the
    // graph in a larger, node-count-based "canvas" and pan/zoom within it.
    const viewportSize = getViewportSize(svgEl);

    const baseCanvasWidth = 900;
    const baseCanvasHeight = 520;

    const svg = d3.select<SVGSVGElement, unknown>(svgEl);
    svg.selectAll('*').remove();

    svg
      .attr('viewBox', `0 0 ${viewportSize.width} ${viewportSize.height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const defs = svg.append('defs');
    const arrowSize = 6;
    const arrowHalfHeight = 3;

    defs
      .append('marker')
      .attr('id', 'wf-arrow')
      .attr('viewBox', `0 ${-arrowHalfHeight} ${arrowSize} ${arrowHalfHeight * 2}`)
      .attr('refX', arrowSize)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', `M0,${-arrowHalfHeight}L${arrowSize},0L0,${arrowHalfHeight}`)
      .attr('fill', colors.textMuted);

    // Arrow marker for selected edges
    defs
      .append('marker')
      .attr('id', 'wf-arrow-selected')
      .attr('viewBox', `0 ${-arrowHalfHeight} ${arrowSize} ${arrowHalfHeight * 2}`)
      .attr('refX', arrowSize)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', `M0,${-arrowHalfHeight}L${arrowSize},0L0,${arrowHalfHeight}`)
      .attr('fill', colors.accentBlue);

    const viewport = svg.append('g');
    viewportGRef.current = viewport;

    hasUserZoomedRef.current = false;
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        viewport.attr('transform', event.transform.toString());
        // Only mark as "user" when the zoom was initiated by an input event.
        if (event.sourceEvent) hasUserZoomedRef.current = true;
      });

    zoomBehaviorRef.current = zoom;
    svg.call(zoom);

    if (!graph) {
      viewport
        .append('text')
        .attr('x', 16)
        .attr('y', 24)
        .attr('fill', colors.textMuted)
        .style('font-size', '12px')
        .style('font-family', 'inherit')
        .text('No workflow graph data.');
      linksGRef.current = null;
      nodesGRef.current = null;
      nodesDataRef.current = [];
      linksDataRef.current = [];
      canvasSizeRef.current = null;
      return;
    }

    // Create nodes with restored positions
    const nodes: GraphNode[] = graph.nodes.map((n) => {
      const saved = nodePositionsRef.current.get(n.id);
      const isPinned = pinnedNodeIdsRef.current.has(n.id);
      const restored = saved ? { ...n, x: saved.x, y: saved.y } : { ...n };
      if (isPinned && saved) {
        restored.fx = saved.x;
        restored.fy = saved.y;
        restored.pinned = true;
      }
      return restored;
    });

    // Layout on a "virtual canvas" sized by node count (not by viewport/screen size).
    // This keeps spacing consistent across small/large displays; users pan/zoom to explore.
    const nodeCount = nodes.length;
    const densityScale = Math.max(1, Math.sqrt(nodeCount / 10));
    const canvasWidth = Math.max(Math.round(baseCanvasWidth * densityScale), viewportSize.width);
    const canvasHeight = Math.max(Math.round(baseCanvasHeight * densityScale), viewportSize.height);
    canvasSizeRef.current = { width: canvasWidth, height: canvasHeight };

    // Build a set of edges to detect bidirectional pairs
    const edgeSet = new Set(graph.links.map((l) => `${l.source}→${l.target}`));

    const links: GraphLink[] = graph.links.map((l) => {
      const from = typeof l.source === 'string' ? l.source : l.source.id;
      const to = typeof l.target === 'string' ? l.target : l.target.id;
      const isBidirectional = edgeSet.has(`${to}→${from}`);
      return { ...l, isBidirectional };
    });

    // Store data refs for visual update effect
    nodesDataRef.current = nodes;
    linksDataRef.current = links;

    const linksG = viewport.append('g').attr('stroke', colors.textMuted).attr('stroke-opacity', 0.85);
    const nodesG = viewport.append('g');

    linksGRef.current = linksG;
    nodesGRef.current = nodesG;

    const linkG = linksG
      .selectAll<SVGGElement, GraphLink>('g.wf-link')
      .data(links, (d) => d.id)
      .join('g')
      .attr('class', 'wf-link');

    // Wider invisible stroke for easier edge selection (excellent UX on touchpads).
    linkG
      .append('path')
      .attr('class', 'wf-link-hit')
      .attr('fill', 'none')
      .attr('stroke', 'transparent')
      .attr('stroke-opacity', 0)
      .attr('stroke-width', 14)
      .style('pointer-events', 'stroke')
      .style('cursor', 'pointer');

    linkG
      .append('path')
      .attr('class', 'wf-link-visual')
      .attr('fill', 'none')
      .attr('stroke-width', 2)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .attr('stroke', colors.textMuted)
      .attr('marker-end', 'url(#wf-arrow)')
      .style('pointer-events', 'none');

    // Optional multiplicity badge (e.g. multiple rules to the same target).
    const badgeG = linkG
      .filter((d) => (d.count ?? 1) > 1)
      .append('g')
      .attr('class', 'wf-link-badge')
      .style('pointer-events', 'none');

    badgeG
      .append('circle')
      .attr('r', 9)
      .attr('fill', colors.badgeFill)
      .attr('stroke', colors.border)
      .attr('stroke-width', 1);

    badgeG
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-size', '10px')
      .style('font-family', 'inherit')
      .style('fill', colors.text)
      .text((d) => String(d.count ?? 1));

    const node = nodesG
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'grab');

    node
      .append('circle')
      .attr('r', 18)
      .attr('fill', colors.nodeFill)
      .attr('stroke', colors.border)
      .attr('stroke-width', 1.5);

    node
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-size', '10px')
      .style('font-family', 'inherit')
      .style('fill', colors.text)
      .text((d) => d.label);

    node
      .append('title')
      .text((d) => (pinnedNodeIdsRef.current.has(d.id)
        ? `${d.id} (pinned)\nDouble-click to unpin`
        : `${d.id}\nDrag to move • Double-click to pin`));

    // Stop existing simulation if any
    if (simulationRef.current) {
      simulationRef.current.stop();
    }

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(180 * densityScale))
      .force('charge', d3.forceManyBody().strength(-600 * densityScale))
      .force('center', d3.forceCenter(canvasWidth / 2, canvasHeight / 2))
      .force('collide', d3.forceCollide(50))
      .alphaDecay(0.05)
      .velocityDecay(0.4);

    simulationRef.current = simulation;

    const nodeRadius = 18;
    const bidirectionalOffset = 12;

    // Enable dragging nodes to manually adjust layout. Dropped nodes become "pinned"
    // (fixed in place) until double-clicked to unpin.
    node.call(
      d3
        .drag<SVGGElement, GraphNode>()
        // Threshold so click-to-select still works (and doesn't get treated as a drag).
        .clickDistance(3)
        .on('start', function (event, d) {
          // Prevent the zoom handler from also interpreting this as a pan gesture.
          event.sourceEvent?.stopPropagation();
          d3.select(this).style('cursor', 'grabbing');
          if (!event.active) simulation.alphaTarget(0.25).restart();
          dragStartRef.current.set(d.id, { x: d.x ?? 0, y: d.y ?? 0, wasPinned: pinnedNodeIdsRef.current.has(d.id) });
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', function (event, d) {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', function (event, d) {
          d3.select(this).style('cursor', 'grab');

          const start = dragStartRef.current.get(d.id);
          dragStartRef.current.delete(d.id);

          const dx = start ? event.x - start.x : 0;
          const dy = start ? event.y - start.y : 0;
          const moved = Math.sqrt(dx * dx + dy * dy) >= 3;

          if (moved) {
            // Keep node pinned where dropped (excellent for manual decluttering).
            lastDragEndedAtRef.current = Date.now();
            pinnedNodeIdsRef.current.add(d.id);
            d.pinned = true;
            d.fx = event.x;
            d.fy = event.y;
            d3.select(this).selectAll('title').data([`${d.id} (pinned)\nDouble-click to unpin`]).join('title').text((v) => v);
          } else if (!start?.wasPinned) {
            // Treat as a click: don't pin, and let simulation keep running.
            d.pinned = false;
            d.fx = null;
            d.fy = null;
          } else {
            // Was pinned and didn't move: keep pinned.
            d.pinned = true;
            d.fx = d.x ?? d.fx ?? null;
            d.fy = d.y ?? d.fy ?? null;
          }

          if (!event.active) simulation.alphaTarget(0);
        }),
    );

    // Start centered at a comfortable, stable scale (1:1 pixels) rather than trying
    // to "fit the whole workflow" into small viewports.
    svg.call(
      zoom.transform,
      d3.zoomIdentity.translate(
        viewportSize.width / 2 - canvasWidth / 2,
        viewportSize.height / 2 - canvasHeight / 2,
      ),
    );

    simulation.on('tick', () => {
      linkG.selectAll<SVGPathElement, GraphLink>('path.wf-link-hit, path.wf-link-visual').attr('d', (d) => {
        const sourceNode = typeof d.source === 'string' ? null : d.source;
        const targetNode = typeof d.target === 'string' ? null : d.target;
        if (!sourceNode || !targetNode) return '';

        const sx = sourceNode.x ?? 0;
        const sy = sourceNode.y ?? 0;
        const tx = targetNode.x ?? 0;
        const ty = targetNode.y ?? 0;

        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) return '';

        // Unit vector along the edge
        const ux = dx / dist;
        const uy = dy / dist;
        // Perpendicular unit vector
        const px = -uy;
        const py = ux;

        if (d.isBidirectional) {
          // For bidirectional pairs, use a constant offset. Since the edge direction
          // flips for the reverse link, the perpendicular vector flips too, so a
          // constant offset cleanly separates the two arrows.
          const offset = bidirectionalOffset;
          // Start point: on the edge of source node, offset perpendicular
          const x1 = sx + ux * nodeRadius + px * offset;
          const y1 = sy + uy * nodeRadius + py * offset;
          // End point: on the edge of target node, offset perpendicular
          const x2 = tx - ux * nodeRadius + px * offset;
          const y2 = ty - uy * nodeRadius + py * offset;
          // Add slight curve for visual clarity
          const mx = (x1 + x2) / 2 + px * offset * 0.6;
          const my = (y1 + y2) / 2 + py * offset * 0.6;

          // Quadratic bezier midpoint at t=0.5: (P0 + 2P1 + P2) / 4
          d._labelX = (x1 + 2 * mx + x2) / 4;
          d._labelY = (y1 + 2 * my + y2) / 4;
          return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
        } else {
          // Straight line from edge of source to edge of target
          const x1 = sx + ux * nodeRadius;
          const y1 = sy + uy * nodeRadius;
          const x2 = tx - ux * nodeRadius;
          const y2 = ty - uy * nodeRadius;
          d._labelX = (x1 + x2) / 2;
          d._labelY = (y1 + y2) / 2;
          return `M${x1},${y1} L${x2},${y2}`;
        }
      });

      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);

      linkG
        .selectAll<SVGGElement, GraphLink>('g.wf-link-badge')
        .attr('transform', (d) => `translate(${d._labelX ?? 0},${d._labelY ?? 0})`);

      // Save positions
      for (const n of nodes) {
        if (n.x !== undefined && n.y !== undefined) {
          nodePositionsRef.current.set(n.id, { x: n.x, y: n.y });
        }
      }
    });

    return () => {
      simulation.stop();
    };
  }, [graph]);

  // Keep the SVG coordinate system aligned with the actual on-screen size (no implicit scaling)
  // and recenter on resize only if the user hasn't started panning/zooming.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const ro = new ResizeObserver(() => {
      const zoom = zoomBehaviorRef.current;
      const canvas = canvasSizeRef.current;
      const viewport = viewportGRef.current;
      if (!zoom || !viewport) return;

      const viewportSize = getViewportSize(svgEl);
      d3.select(svgEl).attr('viewBox', `0 0 ${viewportSize.width} ${viewportSize.height}`);

      if (canvas && !hasUserZoomedRef.current) {
        d3.select(svgEl).call(
          zoom.transform,
          d3.zoomIdentity.translate(
            viewportSize.width / 2 - canvas.width / 2,
            viewportSize.height / 2 - canvas.height / 2,
          ),
        );
      }
    });

    ro.observe(svgEl);
    return () => ro.disconnect();
  }, []);

  // Effect 2: Update visual styles and click handlers when selection/props change
  useEffect(() => {
    const svgEl = svgRef.current;
    const linksG = linksGRef.current;
    const nodesG = nodesGRef.current;

    if (!svgEl || !linksG || !nodesG) return;

    // Resolve design tokens for this render pass
    const colors = getGraphColors();

    const svg = d3.select<SVGSVGElement, unknown>(svgEl);
    const nodes = nodesDataRef.current;
    const links = linksDataRef.current;

    // Update SVG click handler
    svg.on('click', () => props.onSelectionChange(null));

    const updateLinkVisuals = (d3Selection: d3.Selection<SVGGElement, GraphLink, d3.BaseType, unknown>) => {
      d3Selection.select<SVGPathElement>('path.wf-link-visual')
        .attr('stroke-width', (d) => {
          const from = getLinkEndpointId(d.source);
          const to = getLinkEndpointId(d.target);
          if (isSelectedEdge(from, to)) return 3.5;
          return (d.count ?? 1) > 1 ? 2.5 : 2;
        })
        .attr('stroke', (d) => {
          const from = getLinkEndpointId(d.source);
          const to = getLinkEndpointId(d.target);
          return isSelectedEdge(from, to) ? colors.accentBlue : colors.textMuted;
        })
        .attr('marker-end', (d) => {
          const from = getLinkEndpointId(d.source);
          const to = getLinkEndpointId(d.target);
          return isSelectedEdge(from, to) ? 'url(#wf-arrow-selected)' : 'url(#wf-arrow)';
        });

      d3Selection
        .selectAll<SVGCircleElement, GraphLink>('g.wf-link-badge circle')
        .attr('stroke', (d) => {
          const from = getLinkEndpointId(d.source);
          const to = getLinkEndpointId(d.target);
          return isSelectedEdge(from, to) ? colors.accentBlue : colors.border;
        });
    };

    const linkGroups = linksG
      .selectAll<SVGGElement, GraphLink>('g.wf-link')
      .data(links, (d) => d.id);

    updateLinkVisuals(linkGroups);

    linkGroups
      .selectAll<SVGPathElement, GraphLink>('path.wf-link-hit')
      .on('click', (event, d) => {
        event.stopPropagation();
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        props.onSelectionChange({ kind: 'edge', from, to });
      })
      .on('mouseenter', function (_, d) {
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        if (isSelectedEdge(from, to)) return;
        d3.select(this.parentNode as SVGGElement)
          .select<SVGPathElement>('path.wf-link-visual')
          .attr('stroke', colors.text)
          .attr('stroke-width', 3);
      })
      .on('mouseleave', function () {
        const group = d3.select(this.parentNode as SVGGElement) as d3.Selection<SVGGElement, GraphLink, d3.BaseType, unknown>;
        // Re-apply computed styles (selection, multiplicity, etc).
        updateLinkVisuals(group);
      })
      .each(function (d) {
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        const count = d.count ?? 1;
        const title = count > 1 ? `${from} → ${to} (${count} transitions)` : `${from} → ${to}`;
        const g = d3.select(this.parentNode as SVGGElement);
        const existing = g.selectAll('title').data([title]);
        existing.join('title').text((v) => v);
      });

    // Update node styles
    const nodeGroups = nodesG
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes);

    nodeGroups
      .on('click', (event, d) => {
        event.stopPropagation();
        // Ignore click selection right after a drag ends (prevents accidental selection toggles).
        if (Date.now() - lastDragEndedAtRef.current < 250) return;
        props.onSelectionChange({ kind: 'node', id: d.id });
      });

    nodeGroups.on('dblclick', (event, d) => {
      event.stopPropagation();
      // Toggle pin state.
      const wasPinned = pinnedNodeIdsRef.current.has(d.id);
      if (wasPinned) {
        pinnedNodeIdsRef.current.delete(d.id);
        d.pinned = false;
        d.fx = null;
        d.fy = null;
      } else {
        pinnedNodeIdsRef.current.add(d.id);
        d.pinned = true;
        d.fx = d.x ?? null;
        d.fy = d.y ?? null;
      }

      // Update tooltip text immediately.
      nodeGroups
        .filter((n) => n.id === d.id)
        .selectAll('title')
        .data([
          pinnedNodeIdsRef.current.has(d.id)
            ? `${d.id} (pinned)\nDouble-click to unpin`
            : `${d.id}\nDrag to move • Double-click to pin`,
        ])
        .join('title')
        .text((v) => v);

      // Nudge the simulation so connected edges re-settle smoothly.
      const sim = simulationRef.current;
      sim?.alphaTarget(0.15).restart();
      setTimeout(() => sim?.alphaTarget(0), 200);
    });

    nodeGroups
      .select('circle')
      .attr('fill', (d) => (isSelectedNode(d.id) ? colors.nodeFillSelected : colors.nodeFill))
      .attr('stroke', (d) => {
        if (props.currentPhaseId && d.id === props.currentPhaseId) return colors.accentAmber;
        return isSelectedNode(d.id) ? colors.accentBlue : colors.border;
      })
      .attr('stroke-dasharray', (d) => (pinnedNodeIdsRef.current.has(d.id) ? '4 3' : null))
      .attr('stroke-width', (d) => {
        if (props.currentPhaseId && d.id === props.currentPhaseId) return 3;
        return isSelectedNode(d.id) ? 2.5 : 1.5;
      });

    return () => {
      svg.on('click', null);
    };
  }, [graph, props.currentPhaseId, props.onSelectionChange, isSelectedNode, isSelectedEdge]);

  return (
    <svg
      ref={svgRef}
      style={{
        width: '100%',
        height: '100%',
      }}
      role="img"
      aria-label="workflow graph"
    />
  );
}
