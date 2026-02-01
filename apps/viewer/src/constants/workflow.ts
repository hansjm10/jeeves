/**
 * Provider and Model constants for workflow configuration.
 *
 * Models are associated with their providers. Each model has:
 * - label: Display name
 * - hint: Short description
 * - tier: Capability tier (fast/balanced/powerful) for visual indicators
 * - reasoningEfforts: Available reasoning effort levels (Codex models)
 * - thinkingBudgets: Available thinking budget presets (Claude models)
 */

export const PROVIDERS = ['claude', 'codex', 'fake'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type ModelTier = 'fast' | 'balanced' | 'powerful';

export interface ReasoningEffort {
  id: string;
  label: string;
  hint: string;
}

export interface ThinkingBudget {
  id: string;
  label: string;
  hint: string;
  tokens?: number; // undefined means disabled
}

export interface ModelInfo {
  label: string;
  hint: string;
  tier: ModelTier;
  /** Reasoning effort levels for Codex/OpenAI models */
  reasoningEfforts?: ReasoningEffort[];
  /** Thinking budget presets for Claude models */
  thinkingBudgets?: ThinkingBudget[];
}

export interface ProviderInfo {
  label: string;
  hint: string;
  models: Record<string, ModelInfo>;
}

/** Standard reasoning efforts for Codex models (passed via --config model_reasoning_effort="...") */
const CODEX_REASONING_EFFORTS: ReasoningEffort[] = [
  { id: 'minimal', label: 'Minimal', hint: 'Fastest, minimal reasoning' },
  { id: 'low', label: 'Low', hint: 'Light reasoning' },
  { id: 'medium', label: 'Medium', hint: 'Balanced (recommended)' },
  { id: 'high', label: 'High', hint: 'Deep reasoning' },
  { id: 'xhigh', label: 'Extra High', hint: 'Maximum reasoning (slowest)' },
];

/** Standard thinking budgets for Claude models (passed via thinking.budget_tokens) */
const CLAUDE_THINKING_BUDGETS: ThinkingBudget[] = [
  { id: 'none', label: 'None', hint: 'Standard mode, no extended thinking', tokens: undefined },
  { id: 'low', label: 'Low', hint: 'Light thinking (1K tokens)', tokens: 1024 },
  { id: 'medium', label: 'Medium', hint: 'Balanced thinking (4K tokens)', tokens: 4096 },
  { id: 'high', label: 'High', hint: 'Deep thinking (16K tokens)', tokens: 16384 },
  { id: 'max', label: 'Maximum', hint: 'Maximum thinking (64K tokens)', tokens: 65536 },
];

/**
 * Provider definitions with their associated models.
 *
 * Claude models use short aliases that map to full model IDs in the backend.
 * Codex models are passed directly to the Codex CLI.
 */
export const PROVIDER_CONFIG: Record<Provider, ProviderInfo> = {
  claude: {
    label: 'Claude',
    hint: 'Anthropic API',
    models: {
      haiku: {
        label: 'Haiku',
        hint: 'Fast, cost-effective',
        tier: 'fast',
        thinkingBudgets: CLAUDE_THINKING_BUDGETS,
      },
      sonnet: {
        label: 'Sonnet',
        hint: 'Balanced, best for coding',
        tier: 'balanced',
        thinkingBudgets: CLAUDE_THINKING_BUDGETS,
      },
      opus: {
        label: 'Opus',
        hint: 'Most capable',
        tier: 'powerful',
        thinkingBudgets: CLAUDE_THINKING_BUDGETS,
      },
    },
  },
  codex: {
    label: 'Codex',
    hint: 'OpenAI Codex CLI',
    models: {
      'gpt-5.2-codex': {
        label: 'GPT-5.2 Codex',
        hint: 'Latest, optimized for agentic coding',
        tier: 'powerful',
        reasoningEfforts: CODEX_REASONING_EFFORTS,
      },
      'gpt-5.2': {
        label: 'GPT-5.2',
        hint: 'Latest GPT-5.2 base model',
        tier: 'powerful',
        reasoningEfforts: CODEX_REASONING_EFFORTS,
      },
      'gpt-5.1-codex-max': {
        label: 'GPT-5.1 Codex Max',
        hint: 'Frontier model, fast and intelligent',
        tier: 'balanced',
        reasoningEfforts: CODEX_REASONING_EFFORTS.filter((e) => e.id !== 'xhigh'), // xhigh not available
      },
      'gpt-5-codex': {
        label: 'GPT-5 Codex',
        hint: 'GPT-5 optimized for coding',
        tier: 'balanced',
        // No reasoning effort configuration
      },
    },
  },
  fake: {
    label: 'Fake',
    hint: 'Mock provider for testing',
    models: {
      default: {
        label: 'Default',
        hint: 'Mock model',
        tier: 'balanced',
      },
    },
  },
};

/** Get list of model IDs for a provider */
export function getModelsForProvider(provider: Provider | string | undefined): string[] {
  if (!provider || !(provider in PROVIDER_CONFIG)) return [];
  return Object.keys(PROVIDER_CONFIG[provider as Provider].models);
}

/** Get model info for a specific provider and model */
export function getModelInfo(provider: Provider | string | undefined, model: string): ModelInfo | undefined {
  if (!provider || !(provider in PROVIDER_CONFIG)) return undefined;
  return PROVIDER_CONFIG[provider as Provider].models[model];
}

/** Get provider info */
export function getProviderInfo(provider: Provider | string | undefined): ProviderInfo | undefined {
  if (!provider || !(provider in PROVIDER_CONFIG)) return undefined;
  return PROVIDER_CONFIG[provider as Provider];
}
