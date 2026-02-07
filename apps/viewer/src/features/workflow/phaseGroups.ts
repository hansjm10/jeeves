import type { WorkflowResponse } from '../../api/types.js';

export type GroupPhase = 'design' | 'implement' | 'review' | 'complete';

// Group buttons represent intent checkpoints, not declaration order.
// `phase_order` is currently object-key order from YAML and may not match a useful jump target.
const GROUP_ANCHORS: Readonly<Record<GroupPhase, readonly string[]>> = {
  design: ['design_classify', 'design_research', 'design_draft'],
  implement: ['implement_task', 'task_decomposition', 'pre_implementation_check'],
  review: ['prepare_pr', 'code_review'],
  complete: ['complete'],
};

export function groupForPhase(phaseId: string | null): GroupPhase {
  const p = (phaseId ?? '').trim();
  if (!p) return 'design';
  if (p === 'complete') return 'complete';
  if (p.startsWith('design_')) return 'design';
  if (p === 'prepare_pr' || p.startsWith('code_') || p.includes('review')) return 'review';
  return 'implement';
}

function pickAnchor(phaseIds: ReadonlySet<string>, anchors: readonly string[]): string | null {
  for (const anchor of anchors) {
    if (phaseIds.has(anchor)) return anchor;
  }
  return null;
}

export function pickGroupTarget(workflow: WorkflowResponse | null, group: GroupPhase): string | null {
  if (!workflow?.ok) return null;

  const availableIds = new Set(workflow.phases.map((p) => p.id));
  const phaseTypes = new Map(workflow.phases.map((p) => [p.id, p.type] as const));
  const ordered = workflow.phase_order.filter((p) => availableIds.has(p));

  const isDesign = (p: string) => p.startsWith('design_');
  const isTerminal = (p: string) => phaseTypes.get(p) === 'terminal' || p === 'complete';
  const isReview = (p: string) => p === 'prepare_pr' || p.startsWith('code_') || p.includes('review');

  const anchor = pickAnchor(availableIds, GROUP_ANCHORS[group]);
  if (anchor) return anchor;

  if (group === 'design') {
    return ordered.find(isDesign) ?? (availableIds.has(workflow.start_phase) ? workflow.start_phase : null);
  }
  if (group === 'review') return ordered.find(isReview) ?? null;
  if (group === 'complete') return ordered.find(isTerminal) ?? null;

  return ordered.find((p) => !isDesign(p) && !isReview(p) && !isTerminal(p)) ?? null;
}
