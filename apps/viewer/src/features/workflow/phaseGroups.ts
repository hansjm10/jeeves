import type { WorkflowResponse } from '../../api/types.js';

export type GroupPhase = 'design' | 'implement' | 'review' | 'complete';

export function groupForPhase(phaseId: string | null): GroupPhase {
  const p = (phaseId ?? '').trim();
  if (!p) return 'design';
  if (p === 'complete') return 'complete';
  if (p.startsWith('design_')) return 'design';
  if (p === 'prepare_pr' || p.startsWith('code_') || p.includes('review')) return 'review';
  return 'implement';
}

export function pickGroupTarget(workflow: WorkflowResponse | null, group: GroupPhase): string | null {
  if (!workflow?.ok) return null;
  const phaseTypes = new Map(workflow.phases.map((p) => [p.id, p.type] as const));
  const order = workflow.phase_order;

  const isDesign = (p: string) => p.startsWith('design_');
  const isTerminal = (p: string) => phaseTypes.get(p) === 'terminal' || p === 'complete';
  const isReview = (p: string) => p === 'prepare_pr' || p.startsWith('code_') || p.includes('review');

  if (group === 'design') return order.find(isDesign) ?? workflow.start_phase ?? null;
  if (group === 'review') return order.find(isReview) ?? null;
  if (group === 'complete') return order.find(isTerminal) ?? null;
  return order.find((p) => !isDesign(p) && !isReview(p) && !isTerminal(p)) ?? null;
}

