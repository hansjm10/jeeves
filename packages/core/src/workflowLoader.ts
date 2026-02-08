import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  claudeModels,
  isValidClaudeThinkingBudget,
  isValidCodexReasoningEffort,
  phaseTypes,
  supportsCodexReasoningEffort,
  validModels,
  type ClaudeThinkingBudgetId,
  type CodexReasoningEffortId,
  type Phase,
  type PhaseType,
  type Transition,
  type Workflow,
  WorkflowValidationError,
} from './workflow.js';

type UnknownRecord = Record<string, unknown>;

function parsePhaseType(value: unknown, context: string): PhaseType {
  if (value === undefined) return 'execute';
  if (typeof value !== 'string') {
    throw new WorkflowValidationError(`${context}: phase type must be a string`);
  }
  const lowered = value.toLowerCase();
  if ((phaseTypes as readonly string[]).includes(lowered)) return lowered as PhaseType;
  throw new WorkflowValidationError(`${context}: invalid phase type '${value}'`);
}

function validateModel(value: unknown, context: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw new WorkflowValidationError(`${context}: model must be a string`);
  const lowered = value.toLowerCase();
  if ((validModels as readonly string[]).includes(lowered)) return;
  throw new WorkflowValidationError(`${context}: invalid model '${value}'. must be one of: ${validModels.join(', ')}`);
}

function parseCodexReasoningEffort(value: unknown, context: string): CodexReasoningEffortId | undefined {
  if (value === undefined) return undefined;
  if (!isValidCodexReasoningEffort(value)) {
    throw new WorkflowValidationError(
      `${context}: invalid reasoning_effort '${String(value)}'. must be one of: minimal, low, medium, high, xhigh`,
    );
  }
  return value;
}

function parseClaudeThinkingBudget(value: unknown, context: string): ClaudeThinkingBudgetId | undefined {
  if (value === undefined) return undefined;
  if (!isValidClaudeThinkingBudget(value)) {
    throw new WorkflowValidationError(
      `${context}: invalid thinking_budget '${String(value)}'. must be one of: none, low, medium, high, max`,
    );
  }
  return value;
}

const transitionSchema = z
  .object({
    to: z.string().min(1),
    when: z.string().optional(),
    auto: z.boolean().optional().default(false),
    priority: z.number().int().optional().default(0),
  })
  .passthrough()
  .transform((t): Transition => ({
    to: t.to,
    when: t.when,
    auto: t.auto ?? false,
    priority: t.priority ?? 0,
  }));

const rawPhaseSchema = z
  .object({
    type: z.unknown().optional(),
    provider: z.unknown().optional(),
    mcp_profile: z.string().optional(),
    prompt: z.string().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    transitions: z.array(transitionSchema).optional().default([]),
    allowed_writes: z.array(z.string()).optional(),
    status_mapping: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    output_file: z.string().optional(),
    model: z.unknown().optional(),
    reasoning_effort: z.unknown().optional(),
    thinking_budget: z.unknown().optional(),
    permission_mode: z.string().optional(),
  })
  .passthrough();

const rawWorkflowSchema = z
  .object({
	    workflow: z
	      .object({
	        name: z.string().optional(),
	        version: z.number().int().optional().default(1),
	        start: z.string().optional().default('design_classify'),
	        default_provider: z.unknown().optional(),
	        default_model: z.unknown().optional(),
	        default_reasoning_effort: z.unknown().optional(),
	        default_thinking_budget: z.unknown().optional(),
      })
	      .passthrough()
	      .optional()
	      .default(() => ({ version: 1, start: 'design_classify' })),
	    phases: z.record(z.string(), rawPhaseSchema).optional().default({}),
	  })
	  .passthrough();

function normalizeWorkflow(raw: z.output<typeof rawWorkflowSchema>, sourceName: string): Workflow {
  validateModel(raw.workflow.default_model, 'Workflow default_model');
  const defaultReasoningEffort = parseCodexReasoningEffort(
    raw.workflow.default_reasoning_effort,
    'Workflow default_reasoning_effort',
  );
  const defaultThinkingBudget = parseClaudeThinkingBudget(
    raw.workflow.default_thinking_budget,
    'Workflow default_thinking_budget',
  );

  const phases: Record<string, Phase> = {};
  for (const [phaseName, phaseRaw] of Object.entries(raw.phases)) {
    const phaseType = parsePhaseType(phaseRaw.type, `Phase '${phaseName}'`);
    validateModel(phaseRaw.model, `Phase '${phaseName}' model`);
    const reasoningEffort = parseCodexReasoningEffort(phaseRaw.reasoning_effort, `Phase '${phaseName}' reasoning_effort`);
    const thinkingBudget = parseClaudeThinkingBudget(phaseRaw.thinking_budget, `Phase '${phaseName}' thinking_budget`);

    const transitions = [...phaseRaw.transitions].sort((a, b) => a.priority - b.priority);
    phases[phaseName] = {
      name: phaseName,
      type: phaseType,
      provider: typeof phaseRaw.provider === 'string' ? phaseRaw.provider : undefined,
      mcpProfile: phaseRaw.mcp_profile,
      prompt: phaseRaw.prompt,
      command: phaseRaw.command,
      description: phaseRaw.description,
      transitions,
      allowedWrites: phaseRaw.allowed_writes ?? ['.jeeves/*'],
      statusMapping: phaseRaw.status_mapping,
      outputFile: phaseRaw.output_file,
      model: typeof phaseRaw.model === 'string' ? phaseRaw.model : undefined,
      reasoningEffort,
      thinkingBudget,
      permissionMode: phaseRaw.permission_mode,
    };
  }

	  const workflowName = raw.workflow.name ?? sourceName;
	  const workflow: Workflow = {
	    name: workflowName,
	    version: raw.workflow.version ?? 1,
	    start: raw.workflow.start ?? 'design_classify',
	    phases,
	    defaultProvider: typeof raw.workflow.default_provider === 'string' ? raw.workflow.default_provider : undefined,
	    defaultModel: typeof raw.workflow.default_model === 'string' ? raw.workflow.default_model : undefined,
	    defaultReasoningEffort,
    defaultThinkingBudget,
  };

  validateWorkflow(workflow);
  return workflow;
}

function validateWorkflow(workflow: Workflow): void {
  const validateReasoningEffortSupport = (effort: CodexReasoningEffortId, model: string, context: string) => {
    if (!supportsCodexReasoningEffort(model)) {
      throw new WorkflowValidationError(
        `${context}: reasoning_effort requires a Codex model that supports reasoning effort (got '${model}')`,
      );
    }
    if (effort === 'xhigh' && model === 'gpt-5.1-codex-max') {
      throw new WorkflowValidationError(`${context}: reasoning_effort 'xhigh' is not supported for model 'gpt-5.1-codex-max'`);
    }
  };

  const validateThinkingBudgetSupport = (model: string, context: string) => {
    if (!(claudeModels as readonly string[]).includes(model)) {
      throw new WorkflowValidationError(`${context}: thinking_budget requires a Claude model (got '${model}')`);
    }
  };

  if (!workflow.phases[workflow.start]) {
    throw new WorkflowValidationError(`Start phase '${workflow.start}' not found in workflow phases`);
  }

  for (const [phaseName, phase] of Object.entries(workflow.phases)) {
    for (const transition of phase.transitions) {
      if (!workflow.phases[transition.to]) {
        throw new WorkflowValidationError(
          `Phase '${phaseName}' has transition to unknown phase '${transition.to}'`,
        );
      }
    }
  }

  for (const [phaseName, phase] of Object.entries(workflow.phases)) {
    if ((phase.type === 'execute' || phase.type === 'evaluate') && !phase.prompt) {
      throw new WorkflowValidationError(`Phase '${phaseName}' of type '${phase.type}' requires a prompt`);
    }
    if (phase.type === 'script' && !phase.command) {
      throw new WorkflowValidationError(`Script phase '${phaseName}' requires a command`);
    }
  }

  if (workflow.defaultReasoningEffort) {
    const provider = workflow.defaultProvider;
    if (!provider) {
      throw new WorkflowValidationError('Workflow default_reasoning_effort requires workflow.default_provider to be set');
    }
    if (provider !== 'codex') {
      throw new WorkflowValidationError(
        `Workflow default_reasoning_effort requires workflow.default_provider='codex' (got '${provider}')`,
      );
    }
    const model = workflow.defaultModel;
    if (!model) {
      throw new WorkflowValidationError('Workflow default_reasoning_effort requires workflow.default_model to be set');
    }
    validateReasoningEffortSupport(workflow.defaultReasoningEffort, model, 'Workflow default_reasoning_effort');
  }

  if (workflow.defaultThinkingBudget) {
    const provider = workflow.defaultProvider;
    if (!provider) {
      throw new WorkflowValidationError('Workflow default_thinking_budget requires workflow.default_provider to be set');
    }
    if (provider !== 'claude') {
      throw new WorkflowValidationError(
        `Workflow default_thinking_budget requires workflow.default_provider='claude' (got '${provider}')`,
      );
    }
    const model = workflow.defaultModel;
    if (!model) {
      throw new WorkflowValidationError('Workflow default_thinking_budget requires workflow.default_model to be set');
    }
    validateThinkingBudgetSupport(model, 'Workflow default_thinking_budget');
  }

  for (const [phaseName, phase] of Object.entries(workflow.phases)) {
    if (phase.reasoningEffort) {
      const provider = phase.provider ?? workflow.defaultProvider;
      if (!provider) {
        throw new WorkflowValidationError(
          `Phase '${phaseName}' reasoning_effort requires an effective provider (phase.provider or workflow.default_provider)`,
        );
      }
      if (provider !== 'codex') {
        throw new WorkflowValidationError(`Phase '${phaseName}' reasoning_effort requires effective provider 'codex' (got '${provider}')`);
      }
      const model = phase.model ?? workflow.defaultModel;
      if (!model) {
        throw new WorkflowValidationError(
          `Phase '${phaseName}' reasoning_effort requires an effective model (phase.model or workflow.default_model)`,
        );
      }
      validateReasoningEffortSupport(phase.reasoningEffort, model, `Phase '${phaseName}' reasoning_effort`);
    }

    if (phase.thinkingBudget) {
      const provider = phase.provider ?? workflow.defaultProvider;
      if (!provider) {
        throw new WorkflowValidationError(
          `Phase '${phaseName}' thinking_budget requires an effective provider (phase.provider or workflow.default_provider)`,
        );
      }
      if (provider !== 'claude') {
        throw new WorkflowValidationError(`Phase '${phaseName}' thinking_budget requires effective provider 'claude' (got '${provider}')`);
      }
      const model = phase.model ?? workflow.defaultModel;
      if (!model) {
        throw new WorkflowValidationError(
          `Phase '${phaseName}' thinking_budget requires an effective model (phase.model or workflow.default_model)`,
        );
      }
      validateThinkingBudgetSupport(model, `Phase '${phaseName}' thinking_budget`);
    }

    if (phase.permissionMode === 'plan') {
      const provider = phase.provider ?? workflow.defaultProvider;
      if (provider && provider !== 'claude') {
        throw new WorkflowValidationError(
          `Phase '${phaseName}' permission_mode 'plan' requires effective provider 'claude' (got '${provider}')`,
        );
      }
    }
  }
}

export function parseWorkflowYaml(yamlText: string, options?: { sourceName?: string }): Workflow {
  const parsed = parseYaml(yamlText) as unknown;
  const raw = rawWorkflowSchema.parse(parsed);
  return normalizeWorkflow(raw, options?.sourceName ?? 'workflow');
}

export function parseWorkflowObject(raw: unknown, options?: { sourceName?: string }): Workflow {
  const parsed = rawWorkflowSchema.parse(raw);
  return normalizeWorkflow(parsed, options?.sourceName ?? 'workflow');
}

export async function loadWorkflowFromFile(filePath: string): Promise<Workflow> {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseWorkflowYaml(content, { sourceName: path.basename(filePath, path.extname(filePath)) });
}

export async function loadWorkflowByName(
  name: string,
  options?: { workflowsDir?: string },
): Promise<Workflow> {
  if (!name || typeof name !== 'string') throw new WorkflowValidationError('workflow name is required');
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new WorkflowValidationError('invalid workflow name');
  }

  const fileName = name.endsWith('.yaml') ? name : `${name}.yaml`;
  const workflowsDir = path.resolve(options?.workflowsDir ?? path.resolve(process.cwd(), 'workflows'));
  const resolved = path.resolve(workflowsDir, fileName);

  const rel = path.relative(workflowsDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkflowValidationError('invalid workflow name');
  }

  return loadWorkflowFromFile(resolved);
}

export function toRawWorkflowJson(workflow: Workflow): UnknownRecord {
  const phases: Record<string, UnknownRecord> = {};
  for (const [name, phase] of Object.entries(workflow.phases)) {
    const phaseJson: UnknownRecord = {
      type: phase.type,
      description: phase.description ?? '',
      transitions: phase.transitions.map((t) => ({
        to: t.to,
        when: t.when,
        auto: t.auto,
        priority: t.priority,
      })),
    };

    if (phase.provider) phaseJson.provider = phase.provider;
    if (phase.mcpProfile) phaseJson.mcp_profile = phase.mcpProfile;
    if (phase.prompt) phaseJson.prompt = phase.prompt;
    if (phase.command) phaseJson.command = phase.command;
    if (phase.allowedWrites.length !== 1 || phase.allowedWrites[0] !== '.jeeves/*') {
      phaseJson.allowed_writes = [...phase.allowedWrites];
    }
    if (phase.model) phaseJson.model = phase.model;
    if (phase.reasoningEffort) phaseJson.reasoning_effort = phase.reasoningEffort;
    if (phase.thinkingBudget) phaseJson.thinking_budget = phase.thinkingBudget;
    if (phase.permissionMode) phaseJson.permission_mode = phase.permissionMode;
    if (phase.outputFile) phaseJson.output_file = phase.outputFile;
    if (phase.statusMapping) phaseJson.status_mapping = phase.statusMapping;

    phases[name] = phaseJson;
  }

  const workflowJson: UnknownRecord = {
    name: workflow.name,
    version: workflow.version,
    start: workflow.start,
  };
  if (workflow.defaultProvider) workflowJson.default_provider = workflow.defaultProvider;
  if (workflow.defaultModel) workflowJson.default_model = workflow.defaultModel;
  if (workflow.defaultReasoningEffort) workflowJson.default_reasoning_effort = workflow.defaultReasoningEffort;
  if (workflow.defaultThinkingBudget) workflowJson.default_thinking_budget = workflow.defaultThinkingBudget;

  return { workflow: workflowJson, phases };
}

export function toWorkflowYaml(workflow: Workflow): string {
  validateWorkflow(workflow);

  const workflowJson: UnknownRecord = {
    name: workflow.name,
    version: workflow.version,
    start: workflow.start,
  };
  if (workflow.defaultProvider) workflowJson.default_provider = workflow.defaultProvider;
  if (workflow.defaultModel) workflowJson.default_model = workflow.defaultModel;
  if (workflow.defaultReasoningEffort) workflowJson.default_reasoning_effort = workflow.defaultReasoningEffort;
  if (workflow.defaultThinkingBudget) workflowJson.default_thinking_budget = workflow.defaultThinkingBudget;

  const phasesJson: Record<string, UnknownRecord> = {};
  const phaseNames = Object.keys(workflow.phases).sort((a, b) => a.localeCompare(b));
  for (const phaseName of phaseNames) {
    const phase = workflow.phases[phaseName];

    const phaseJson: UnknownRecord = {
      type: phase.type,
    };
    if (phase.provider) phaseJson.provider = phase.provider;
    if (phase.mcpProfile) phaseJson.mcp_profile = phase.mcpProfile;
    if (phase.prompt) phaseJson.prompt = phase.prompt;
    if (phase.command) phaseJson.command = phase.command;
    if (phase.description) phaseJson.description = phase.description;

    const transitions = [...phase.transitions].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.to !== b.to) return a.to.localeCompare(b.to);
      return (a.when ?? '').localeCompare(b.when ?? '');
    });
    phaseJson.transitions = transitions.map((t) => {
      const transitionJson: UnknownRecord = { to: t.to };
      if (t.when) transitionJson.when = t.when;
      if (t.auto) transitionJson.auto = t.auto;
      if (t.priority !== 0) transitionJson.priority = t.priority;
      return transitionJson;
    });

    if (phase.allowedWrites.length !== 1 || phase.allowedWrites[0] !== '.jeeves/*') {
      phaseJson.allowed_writes = [...phase.allowedWrites];
    }
    if (phase.statusMapping) phaseJson.status_mapping = phase.statusMapping;
    if (phase.outputFile) phaseJson.output_file = phase.outputFile;
    if (phase.model) phaseJson.model = phase.model;
    if (phase.reasoningEffort) phaseJson.reasoning_effort = phase.reasoningEffort;
    if (phase.thinkingBudget) phaseJson.thinking_budget = phase.thinkingBudget;
    if (phase.permissionMode) phaseJson.permission_mode = phase.permissionMode;

    phasesJson[phaseName] = phaseJson;
  }

  return stringifyYaml({ workflow: workflowJson, phases: phasesJson }, { indent: 2 });
}
