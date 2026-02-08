export const phaseTypes = ['execute', 'evaluate', 'script', 'terminal'] as const;
export type PhaseType = (typeof phaseTypes)[number];

/** Claude model aliases */
export const claudeModels = ['sonnet', 'opus', 'haiku'] as const;
export type ClaudeModelId = (typeof claudeModels)[number];

/** Codex/OpenAI model IDs */
export const codexModels = ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5-codex'] as const;
export type CodexModelId = (typeof codexModels)[number];

/** Codex reasoning effort IDs */
export const codexReasoningEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffortId = (typeof codexReasoningEfforts)[number];

/** Claude thinking budget IDs */
export const claudeThinkingBudgets = ['none', 'low', 'medium', 'high', 'max'] as const;
export type ClaudeThinkingBudgetId = (typeof claudeThinkingBudgets)[number];

/** Codex models that support reasoning effort configuration */
export const codexModelsWithReasoningEffort = ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max'] as const;
export type CodexModelWithReasoningEffortId = (typeof codexModelsWithReasoningEffort)[number];

/** All valid models across providers */
export const validModels = [...claudeModels, ...codexModels] as const;
export type ModelId = ClaudeModelId | CodexModelId;

export function isValidModel(model: unknown): model is ModelId {
  return typeof model === 'string' && (validModels as readonly string[]).includes(model);
}

export function isValidCodexReasoningEffort(value: unknown): value is CodexReasoningEffortId {
  return typeof value === 'string' && (codexReasoningEfforts as readonly string[]).includes(value);
}

export function isValidClaudeThinkingBudget(value: unknown): value is ClaudeThinkingBudgetId {
  return typeof value === 'string' && (claudeThinkingBudgets as readonly string[]).includes(value);
}

export function supportsCodexReasoningEffort(model: unknown): model is CodexModelWithReasoningEffortId {
  return typeof model === 'string' && (codexModelsWithReasoningEffort as readonly string[]).includes(model);
}

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
  provider?: string;
  mcpProfile?: string;
  prompt?: string;
  command?: string;
  description?: string;
  transitions: readonly Transition[];
  allowedWrites: readonly string[];
  statusMapping?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  outputFile?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffortId;
  thinkingBudget?: ClaudeThinkingBudgetId;
  permissionMode?: string;
}>;

export type Workflow = Readonly<{
  name: string;
  version: number;
  start: string;
  phases: Readonly<Record<string, Phase>>;
  defaultProvider?: string;
  defaultModel?: string;
  defaultReasoningEffort?: CodexReasoningEffortId;
  defaultThinkingBudget?: ClaudeThinkingBudgetId;
}>;

export function getEffectiveModel(workflow: Workflow, phaseName: string): string | undefined {
  const phase = workflow.phases[phaseName];
  if (!phase) return undefined;
  return phase.model ?? workflow.defaultModel;
}
