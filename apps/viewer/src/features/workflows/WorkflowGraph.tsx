import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';

export type WorkflowGraphSelection =
  | Readonly<{ kind: 'node'; id: string }>
  | Readonly<{ kind: 'edge'; from: string; to: string }>
  | null;

type GraphNode = d3.SimulationNodeDatum & Readonly<{ id: string; label: string }>;
type GraphLink = d3.SimulationLinkDatum<GraphNode> &
  Readonly<{
    id: string;
    source: string | GraphNode;
    target: string | GraphNode;
  }>;

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

  const graph = useMemo(() => {
    if (!props.workflow) return null;
    return parseWorkflowGraph(props.workflow);
  }, [props.workflow]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const width = 900;
    const height = 520;

    const svg = d3.select<SVGSVGElement, unknown>(svgEl);
    svg.selectAll('*').remove();

    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet');

    svg.on('click', () => props.onSelectionChange(null));

    const defs = svg.append('defs');
    defs
      .append('marker')
      .attr('id', 'wf-arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 14)
      .attr('refY', 0)
      .attr('markerWidth', 8)
      .attr('markerHeight', 8)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', '#98a2b3');

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
        .attr('fill', '#666')
        .style('font-size', '12px')
        .text('No workflow graph data.');
      return;
    }

    const nodes: GraphNode[] = graph.nodes.map((n) => ({ ...n }));
    const links: GraphLink[] = graph.links.map((l) => ({ ...l }));

    const isSelectedNode = (id: string) => props.selection?.kind === 'node' && props.selection.id === id;
    const isSelectedEdge = (from: string, to: string) =>
      props.selection?.kind === 'edge' && props.selection.from === from && props.selection.to === to;

    const linksG = viewport.append('g').attr('stroke', '#98a2b3').attr('stroke-opacity', 0.85);
    const nodesG = viewport.append('g');

    const link = linksG
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke-width', (d) => {
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        return isSelectedEdge(from, to) ? 3 : 1.5;
      })
      .attr('stroke', (d) => {
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        return isSelectedEdge(from, to) ? '#2563eb' : '#98a2b3';
      })
      .attr('marker-end', 'url(#wf-arrow)')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        const from = getLinkEndpointId(d.source);
        const to = getLinkEndpointId(d.target);
        props.onSelectionChange({ kind: 'edge', from, to });
      });

    const node = nodesG
      .selectAll('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        props.onSelectionChange({ kind: 'node', id: d.id });
      });

    node
      .append('circle')
      .attr('r', 18)
      .attr('fill', (d) => (isSelectedNode(d.id) ? '#dbeafe' : '#fff'))
      .attr('stroke', (d) => {
        if (props.currentPhaseId && d.id === props.currentPhaseId) return '#f59e0b';
        return isSelectedNode(d.id) ? '#2563eb' : '#94a3b8';
      })
      .attr('stroke-width', (d) => {
        if (props.currentPhaseId && d.id === props.currentPhaseId) return 3;
        return isSelectedNode(d.id) ? 2.5 : 1.5;
      });

    node
      .append('text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .style('font-size', '10px')
      .style('fill', '#111827')
      .text((d) => d.label);

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-620))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(34));

    simulation.on('tick', () => {
      link
        .attr('x1', (d) => (typeof d.source === 'string' ? 0 : (d.source.x ?? 0)))
        .attr('y1', (d) => (typeof d.source === 'string' ? 0 : (d.source.y ?? 0)))
        .attr('x2', (d) => (typeof d.target === 'string' ? 0 : (d.target.x ?? 0)))
        .attr('y2', (d) => (typeof d.target === 'string' ? 0 : (d.target.y ?? 0)));

      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    return () => {
      simulation.stop();
      svg.on('click', null);
    };
  }, [graph, props.currentPhaseId, props.selection, props.onSelectionChange]);

  return (
    <svg
      ref={svgRef}
      style={{
        width: '100%',
        height: '100%',
        background: 'white',
        border: '1px dashed #bbb',
        borderRadius: 6,
      }}
      role="img"
      aria-label="workflow graph"
    />
  );
}
