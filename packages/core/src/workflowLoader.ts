import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { phaseTypes, validModels, type Phase, type PhaseType, type Transition, type Workflow, WorkflowValidationError } from './workflow.js';

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
    prompt: z.string().optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    transitions: z.array(transitionSchema).optional().default([]),
    allowed_writes: z.array(z.string()).optional(),
    status_mapping: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    output_file: z.string().optional(),
    model: z.unknown().optional(),
  })
  .passthrough();

const rawWorkflowSchema = z
  .object({
    workflow: z
      .object({
        name: z.string().optional(),
        version: z.number().int().optional().default(1),
        start: z.string().optional().default('design_draft'),
        default_provider: z.unknown().optional(),
        default_model: z.unknown().optional(),
      })
      .passthrough()
      .optional()
      .default(() => ({ version: 1, start: 'design_draft' })),
    phases: z.record(z.string(), rawPhaseSchema).optional().default({}),
  })
  .passthrough();

function normalizeWorkflow(raw: z.output<typeof rawWorkflowSchema>, sourceName: string): Workflow {
  validateModel(raw.workflow.default_model, 'Workflow default_model');

  const phases: Record<string, Phase> = {};
  for (const [phaseName, phaseRaw] of Object.entries(raw.phases)) {
    const phaseType = parsePhaseType(phaseRaw.type, `Phase '${phaseName}'`);
    validateModel(phaseRaw.model, `Phase '${phaseName}' model`);

    const transitions = [...phaseRaw.transitions].sort((a, b) => a.priority - b.priority);
    phases[phaseName] = {
      name: phaseName,
      type: phaseType,
      provider: typeof phaseRaw.provider === 'string' ? phaseRaw.provider : undefined,
      prompt: phaseRaw.prompt,
      command: phaseRaw.command,
      description: phaseRaw.description,
      transitions,
      allowedWrites: phaseRaw.allowed_writes ?? ['.jeeves/*'],
      statusMapping: phaseRaw.status_mapping,
      outputFile: phaseRaw.output_file,
      model: typeof phaseRaw.model === 'string' ? phaseRaw.model : undefined,
    };
  }

  const workflowName = raw.workflow.name ?? sourceName;
  const workflow: Workflow = {
    name: workflowName,
    version: raw.workflow.version ?? 1,
    start: raw.workflow.start ?? 'design_draft',
    phases,
    defaultProvider: typeof raw.workflow.default_provider === 'string' ? raw.workflow.default_provider : undefined,
    defaultModel: typeof raw.workflow.default_model === 'string' ? raw.workflow.default_model : undefined,
  };

  validateWorkflow(workflow);
  return workflow;
}

function validateWorkflow(workflow: Workflow): void {
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

    if (phase.prompt) phaseJson.prompt = phase.prompt;
    if (phase.command) phaseJson.command = phase.command;
    if (phase.allowedWrites.length !== 1 || phase.allowedWrites[0] !== '.jeeves/*') {
      phaseJson.allowed_writes = [...phase.allowedWrites];
    }
    if (phase.model) phaseJson.model = phase.model;
    if (phase.outputFile) phaseJson.output_file = phase.outputFile;
    if (phase.statusMapping) phaseJson.status_mapping = phase.statusMapping;

    phases[name] = phaseJson;
  }

  const workflowJson: UnknownRecord = {
    name: workflow.name,
    version: workflow.version,
    start: workflow.start,
  };
  if (workflow.defaultModel) workflowJson.default_model = workflow.defaultModel;

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

  const phasesJson: Record<string, UnknownRecord> = {};
  const phaseNames = Object.keys(workflow.phases).sort((a, b) => a.localeCompare(b));
  for (const phaseName of phaseNames) {
    const phase = workflow.phases[phaseName];

    const phaseJson: UnknownRecord = {
      type: phase.type,
    };
    if (phase.provider) phaseJson.provider = phase.provider;
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

    phasesJson[phaseName] = phaseJson;
  }

  return stringifyYaml({ workflow: workflowJson, phases: phasesJson }, { indent: 2 });
}
