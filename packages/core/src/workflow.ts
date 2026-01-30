export const phaseTypes = ['execute', 'evaluate', 'script', 'terminal'] as const;
export type PhaseType = (typeof phaseTypes)[number];

export const validModels = ['sonnet', 'opus', 'haiku'] as const;
export type ModelId = (typeof validModels)[number];

export class WorkflowValidationError extends Error {
  override name = 'WorkflowValidationError';
}

export type Transition = Readonly<{
  to: string;
  when?: string;
  auto: boolean;
  priority: number;
}>;

export type Phase = Readonly<{
  name: string;
  type: PhaseType;
  prompt?: string;
  command?: string;
  description?: string;
  transitions: readonly Transition[];
  allowedWrites: readonly string[];
  statusMapping?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  outputFile?: string;
  model?: string;
}>;

export type Workflow = Readonly<{
  name: string;
  version: number;
  start: string;
  phases: Readonly<Record<string, Phase>>;
  defaultModel?: string;
}>;

export function getEffectiveModel(workflow: Workflow, phaseName: string): string | undefined {
  const phase = workflow.phases[phaseName];
  if (!phase) return undefined;
  return phase.model ?? workflow.defaultModel;
}
