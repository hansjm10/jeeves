import { useEffect, useMemo, useRef, useCallback } from 'react';
import * as d3 from 'd3';

export type WorkflowGraphSelection =
  | Readonly<{ kind: 'node'; id: string }>
  | Readonly<{ kind: 'edge'; from: string; to: string }>
  | null;

type GraphNode = d3.SimulationNodeDatum & Readonly<{ id: string; label: string }>;
type GraphLink = d3.SimulationLinkDatum<GraphNode> & {
  readonly id: string;
  source: string | GraphNode;
  target: string | GraphNode;
  // Added for bidirectional edge rendering
  isBidirectional?: boolean;
  curveDirection?: number;
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

  const links: GraphLink[] = [];

  for (const [from, phaseRaw] of Object.entries(phasesRaw)) {
    if (!isRecord(phaseRaw)) continue;
    const transitions = phaseRaw.transitions;
    if (!Array.isArray(transitions)) continue;
    for (const t of transitions) {
      if (!isRecord(t)) continue;
      const to = t.to;
      if (typeof to !== 'string' || !to.trim()) continue;
      links.push({ id: `${from}→${to}`, source: from, target: to });
    }
  }

  return { nodes, links };
}

function getLinkEndpointId(v: string | GraphNode): string {
  return typeof v === 'string' ? v : v.id;
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
  const linksGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodesGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
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

    const width = 900;
    const height = 520;

    const svg = d3.select<SVGSVGElement, unknown>(svgEl);
    svg.selectAll('*').remove();

    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const defs = svg.append('defs');
    defs
      .append('marker')
      .attr('id', 'wf-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10)
      .attr('refY', 0)
      .attr('markerWidth', 8)
      .attr('markerHeight', 8)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#8b9bb4');

    // Arrow marker for selected edges
    defs
      .append('marker')
      .attr('id', 'wf-arrow-selected')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 10)
      .attr('refY', 0)
      .attr('markerWidth', 8)
      .attr('markerHeight', 8)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#63b3ed');

    const viewport = svg.append('g');
    svg.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 4])
        .on('zoom', (event) => viewport.attr('transform', event.transform)),
    );

    if (!graph) {
      viewport
        .append('text')
        .attr('x', 16)
        .attr('y', 24)
        .attr('fill', '#6b7a8f')
        .style('font-size', '12px')
        .style('font-family', 'inherit')
        .text('No workflow graph data.');
      linksGRef.current = null;
      nodesGRef.current = null;
      nodesDataRef.current = [];
      linksDataRef.current = [];
      return;
    }

    // Create nodes with restored positions
    const nodes: GraphNode[] = graph.nodes.map((n) => {
      const saved = nodePositionsRef.current.get(n.id);
      return saved ? { ...n, x: saved.x, y: saved.y } : { ...n };
    });

    // Build a set of edges to detect bidirectional pairs
    const edgeSet = new Set(graph.links.map((l) => `${l.source}→${l.target}`));

    const links: GraphLink[] = graph.links.map((l) => {
      const from = typeof l.source === 'string' ? l.source : l.source.id;
      const to = typeof l.target === 'string' ? l.target : l.target.id;
      const isBidirectional = edgeSet.has(`${to}→${from}`);
      // Curve direction based on alphabetical order so A→B curves one way, B→A curves the other
      const curveDirection = from < to ? 1 : -1;
      return { ...l, isBidirectional, curveDirection };
    });

    // Store data refs for visual update effect
    nodesDataRef.current = nodes;
    linksDataRef.current = links;

    const linksG = viewport.append('g').attr('stroke', '#6b7a8f').attr('stroke-opacity', 0.85);
    const nodesG = viewport.append('g');

    linksGRef.current = linksG;
    nodesGRef.current = nodesG;

    const link = linksG
      .selectAll('path')
      .data(links)
      .join('path')
      .attr('fill', 'none')
      .attr('stroke-width', 2)
      .attr('stroke', '#6b7a8f')
      .attr('marker-end', 'url(#wf-arrow)')
      .style('cursor', 'pointer');

    const node = nodesG
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer');

    node
      .append('circle')
      .attr('r', 18)
      .attr('fill', '#12171e')
      .attr('stroke', '#4a5668')
      .attr('stroke-width', 1.5);

    node
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-size', '10px')
      .style('font-family', 'inherit')
      .style('fill', '#e8eef5')
      .text((d) => d.label);

    // Stop existing simulation if any
    if (simulationRef.current) {
      simulationRef.current.stop();
    }

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(180))
      .force('charge', d3.forceManyBody().strength(-600))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(50))
      .alphaDecay(0.05)
      .velocityDecay(0.4);

    simulationRef.current = simulation;

    const nodeRadius = 18;

    simulation.on('tick', () => {
      link.attr('d', (d) => {
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
          // Offset start/end points perpendicular to edge direction
          const offset = 8 * (d.curveDirection ?? 1);
          // Start point: on the edge of source node, offset perpendicular
          const x1 = sx + ux * nodeRadius + px * offset;
          const y1 = sy + uy * nodeRadius + py * offset;
          // End point: on the edge of target node, offset perpendicular
          const x2 = tx - ux * nodeRadius + px * offset;
          const y2 = ty - uy * nodeRadius + py * offset;
          // Add slight curve for visual clarity
          const mx = (x1 + x2) / 2 + px * offset * 0.5;
          const my = (y1 + y2) / 2 + py * offset * 0.5;
          return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
        } else {
          // Straight line from edge of source to edge of target
          const x1 = sx + ux * nodeRadius;
          const y1 = sy + uy * nodeRadius;
          const x2 = tx - ux * nodeRadius;
          const y2 = ty - uy * nodeRadius;
          return `M${x1},${y1} L${x2},${y2}`;
        }
      });

      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);

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

  // Effect 2: Update visual styles and click handlers when selection/props change
  useEffect(() => {
    const svgEl = svgRef.current;
    const linksG = linksGRef.current;
    const nodesG = nodesGRef.current;

    if (!svgEl || !linksG || !nodesG) return;

    const svg = d3.select<SVGSVGElement, unknown>(svgEl);
    const nodes = nodesDataRef.current;
    const links = linksDataRef.current;

    // Update SVG click handler
    svg.on('click', () => props.onSelectionChange(null));

    // Update link styles
    linksG
      .selectAll<SVGPathElement, GraphLink>('path')
      .data(links)
      .attr('stroke-width', (d) => {
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        return isSelectedEdge(from, to) ? 3.5 : 2;
      })
      .attr('stroke', (d) => {
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        return isSelectedEdge(from, to) ? '#63b3ed' : '#6b7a8f';
      })
      .attr('marker-end', (d) => {
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        return isSelectedEdge(from, to) ? 'url(#wf-arrow-selected)' : 'url(#wf-arrow)';
      })
      .on('click', (event, d) => {
        event.stopPropagation();
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        props.onSelectionChange({ kind: 'edge', from, to });
      });

    // Update node styles
    const nodeGroups = nodesG
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes);

    nodeGroups
      .on('click', (event, d) => {
        event.stopPropagation();
        props.onSelectionChange({ kind: 'node', id: d.id });
      });

    nodeGroups
      .select('circle')
      .attr('fill', (d) => (isSelectedNode(d.id) ? '#1a2028' : '#12171e'))
      .attr('stroke', (d) => {
        if (props.currentPhaseId && d.id === props.currentPhaseId) return '#ecc94b';
        return isSelectedNode(d.id) ? '#63b3ed' : '#4a5668';
      })
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
