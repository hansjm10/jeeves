import fs from 'node:fs/promises';
import path from 'node:path';

import { loadWorkflowByName, resolvePromptPath, WorkflowEngine } from '@jeeves/core';
import { appendRunLogLine, upsertRunSession } from '@jeeves/state-db';

import { ensureJeevesExcludedFromGitStatus } from './gitExclude.js';
import { buildMcpServersConfig } from './mcpConfig.js';
import type { AgentProvider, McpServerConfig } from './provider.js';
import { appendProgress, ensureProgressFile, markEnded, markPhase, markStarted } from './progress.js';
import { SdkOutputWriterV1 } from './outputWriter.js';

const PREPENDED_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

export type RunPhaseParams = Readonly<{
  provider: AgentProvider;
  promptPath: string;
  outputPath: string;
  logPath: string;
  progressPath: string;
  stateDir: string;
  cwd: string;
  phaseName: string;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  mcpProfile?: string;
  permissionMode?: string;
}>;

type RunDbContext = Readonly<{
  dataDir: string;
  runId: string;
  scope: string;
  taskId: string;
}>;

function resolveRunDbContextFromEnv(): RunDbContext | null {
  const dataDir = process.env.JEEVES_DATA_DIR?.trim() ?? '';
  const runId = process.env.JEEVES_RUN_ID?.trim() ?? '';
  if (!dataDir || !runId) return null;
  const scope = process.env.JEEVES_RUN_SCOPE?.trim() || 'canonical';
  const taskId = process.env.JEEVES_RUN_TASK_ID?.trim() || '';
  return { dataDir, runId, scope, taskId };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function tryParseJsonRecord(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeTaskPlanPath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/').toLowerCase();
}

function isTaskPlanPath(filePath: string): boolean {
  const normalized = normalizeTaskPlanPath(filePath);
  return normalized.endsWith('task-plan.md') || normalized.endsWith('task_plan.md');
}

function extractTaskPlanWriteFromEnvelope(envelope: Record<string, unknown>): string | null {
  const role = typeof envelope.role === 'string' ? envelope.role.trim().toLowerCase() : null;
  const content = envelope.content;
  if (role !== 'assistant' || !Array.isArray(content)) return null;

  let latestPlanWrite: string | null = null;
  for (const block of content) {
    if (!isPlainRecord(block)) continue;
    if (block.type !== 'tool_use') continue;
    const toolName = typeof block.name === 'string' ? block.name.trim().toLowerCase() : '';
    if (toolName !== 'write') continue;
    const input = isPlainRecord(block.input) ? block.input : null;
    if (!input) continue;
    const filePath = typeof input.file_path === 'string' ? input.file_path : null;
    const writeContent = typeof input.content === 'string' ? input.content : null;
    if (!filePath || !writeContent || !isTaskPlanPath(filePath)) continue;
    latestPlanWrite = writeContent;
  }
  return latestPlanWrite;
}

function isStructuredAssistantEnvelope(envelope: Record<string, unknown>): boolean {
  const role = typeof envelope.role === 'string' ? envelope.role.trim().toLowerCase() : null;
  return role === 'assistant' && Array.isArray(envelope.content);
}

function extractAssistantTextFromEnvelope(envelope: Record<string, unknown>): string | null {
  if (!isStructuredAssistantEnvelope(envelope)) return null;
  const content = envelope.content as unknown[];
  const textParts: string[] = [];

  for (const block of content) {
    if (!isPlainRecord(block)) continue;
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    textParts.push(block.text);
  }

  const joined = textParts.join('').trim();
  return joined || null;
}

function extractAssistantChunk(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const envelope = tryParseJsonRecord(trimmed);
  if (!envelope) return trimmed;

  const textFromEnvelope = extractAssistantTextFromEnvelope(envelope);
  if (textFromEnvelope) return textFromEnvelope;

  // Ignore structured SDK envelopes that contain tool-only assistant blocks.
  if (isStructuredAssistantEnvelope(envelope)) return null;

  // Keep plain assistant JSON output if it is not an SDK wrapper.
  return trimmed;
}

export function extractTaskPlanFromSdkOutput(raw: string): string {
  const parsed = JSON.parse(raw) as { messages?: unknown };
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

  let latestTaskPlanWrite: string | null = null;
  const assistantChunks: string[] = [];

  for (const message of messages) {
    if (!isPlainRecord(message)) continue;
    if (message.type !== 'assistant') continue;
    if (typeof message.content !== 'string') continue;

    const envelope = tryParseJsonRecord(message.content.trim());
    if (envelope) {
      const planWrite = extractTaskPlanWriteFromEnvelope(envelope);
      if (planWrite && planWrite.trim()) latestTaskPlanWrite = planWrite;
    }

    const chunk = extractAssistantChunk(message.content);
    if (chunk) assistantChunks.push(chunk);
  }

  if (latestTaskPlanWrite && latestTaskPlanWrite.trim()) return latestTaskPlanWrite;
  return assistantChunks.join('\n\n').trim();
}

async function buildPromptWithPrependedInstructions(
  phasePrompt: string,
  cwd: string,
): Promise<Readonly<{ prompt: string; prependedFiles: readonly string[] }>> {
  const sections: string[] = [];
  const prependedFiles: string[] = [];

  for (const fileName of PREPENDED_INSTRUCTION_FILES) {
    const filePath = path.join(cwd, fileName);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    const trimmed = content.trim();
    if (!trimmed) continue;
    sections.push(`### ${fileName}\n\n${trimmed}`);
    prependedFiles.push(fileName);
  }

  if (sections.length === 0) {
    return { prompt: phasePrompt, prependedFiles };
  }

  const preface = [
    '<workspace_instructions>',
    'The following repository instruction files are prepended for this run.',
    sections.join('\n\n'),
    '</workspace_instructions>',
  ].join('\n\n');

  return {
    prompt: `${preface}\n\n${phasePrompt}`,
    prependedFiles,
  };
}

export async function runPhaseOnce(params: RunPhaseParams): Promise<{ success: boolean }> {
  const runDbContext = resolveRunDbContextFromEnv();
  await ensureJeevesExcludedFromGitStatus(params.cwd).catch(() => void 0);
  await fs.mkdir(path.dirname(params.outputPath), { recursive: true });
  await fs.mkdir(path.dirname(params.logPath), { recursive: true });
  await ensureProgressFile(params.progressPath);

  if (runDbContext) {
    upsertRunSession({
      dataDir: runDbContext.dataDir,
      runId: runDbContext.runId,
      stateDir: params.stateDir,
      status: {
        phase: params.phaseName,
        runner: 'runPhaseOnce',
      },
    });
  }

  await markStarted(params.progressPath);
  await markPhase(params.progressPath, params.phaseName);

  const phasePrompt = await fs.readFile(params.promptPath, 'utf-8');
  const { prompt, prependedFiles } = await buildPromptWithPrependedInstructions(phasePrompt, params.cwd);

  await fs.writeFile(params.logPath, '', 'utf-8');
  const logStream = await fs.open(params.logPath, 'a');

  const writer = new SdkOutputWriterV1({
    outputPath: params.outputPath,
    dbContext: runDbContext,
  });
  const logLine = async (line: string): Promise<void> => {
    const stamped = `${new Date().toISOString()} ${line}`;
    await logStream.appendFile(`${stamped}\n`, 'utf-8');
    if (runDbContext) {
      appendRunLogLine({
        dataDir: runDbContext.dataDir,
        runId: runDbContext.runId,
        scope: runDbContext.scope,
        taskId: runDbContext.taskId,
        stream: 'log',
        line: stamped,
      });
    }
  };

  try {
    await logLine(`[RUNNER] provider=${params.provider.name}`);
    await logLine(`[RUNNER] phase=${params.phaseName}`);
    await logLine(`[RUNNER] prompt=${params.promptPath}`);
    if (prependedFiles.length > 0) {
      await logLine(`[RUNNER] prepended_instructions=${prependedFiles.join(',')}`);
    }

    const mcpServers = params.mcpServers ?? buildMcpServersConfig(process.env, params.cwd, {
      stateDir: params.stateDir,
      profile: params.mcpProfile,
    });

    for await (const evt of params.provider.run(prompt, { cwd: params.cwd, ...(mcpServers ? { mcpServers } : {}), ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}) })) {
      writer.addProviderEvent(evt);

      if (evt.type === 'assistant' || evt.type === 'user' || evt.type === 'result') {
        await logLine(`[${evt.type.toUpperCase()}] ${evt.content}`);
      } else if (evt.type === 'system') {
        await logLine(`[SYSTEM${evt.subtype ? `:${evt.subtype}` : ''}] ${evt.content}`);
        if (evt.sessionId !== undefined) writer.setSessionId(evt.sessionId);
      } else if (evt.type === 'tool_use') {
        await logLine(`[TOOL] ${evt.name} ${JSON.stringify(evt.input)}`);
      } else if (evt.type === 'tool_result') {
        await logLine(`[TOOL_RESULT] ${evt.toolUseId} ${evt.content}`);
      } else if (evt.type === 'usage') {
        const u = evt.usage;
        const costStr = u.total_cost_usd != null ? ` cost=$${u.total_cost_usd.toFixed(4)}` : '';
        await logLine(`[USAGE] in=${u.input_tokens} out=${u.output_tokens}${costStr}`);
      }

      await writer.writeIncremental();
    }

    writer.finalize(true);
    await writer.writeIncremental({ force: true });
    await markEnded(params.progressPath, true);
    await appendProgress(params.progressPath, '');
    return { success: true };
  } catch (err) {
    writer.setError(err);
    writer.finalize(false);
    await writer.writeIncremental({ force: true });
    await logLine(`[ERROR] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    await markEnded(params.progressPath, false);
    return { success: false };
  } finally {
    await logStream.close();
  }
}

export type RunWorkflowParams = Readonly<{
  provider: AgentProvider;
  workflowName: string;
  phaseName?: string;
  workflowsDir: string;
  promptsDir: string;
  stateDir: string;
  cwd: string;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
}>;

export async function runWorkflowOnce(params: RunWorkflowParams): Promise<{ finalPhase: string; success: boolean }> {
  const workflow = await loadWorkflowByName(params.workflowName, { workflowsDir: params.workflowsDir });
  const engine = new WorkflowEngine(workflow);

  let current = workflow.start;
  while (!engine.isTerminal(current)) {
    const promptPath = await resolvePromptPath(current, params.promptsDir, engine);
    const outputPath = path.join(params.stateDir, 'sdk-output.json');
    const logPath = path.join(params.stateDir, 'last-run.log');
    const progressPath = path.join(params.stateDir, 'progress.txt');

    const phaseResult = await runPhaseOnce({
      provider: params.provider,
      promptPath,
      outputPath,
      logPath,
      progressPath,
      stateDir: params.stateDir,
      cwd: params.cwd,
      phaseName: current,
      mcpServers: params.mcpServers,
      mcpProfile: workflow.phases[current]?.mcpProfile,
    });

    if (!phaseResult.success) {
      return { finalPhase: current, success: false };
    }

    // Minimal workflow support: advance only via auto transitions unless the
    // caller supplies richer status/context in the future.
    const next = engine.evaluateTransitions(current, { status: {} });
    if (!next) return { finalPhase: current, success: true };
    current = next;
  }

  return { finalPhase: current, success: true };
}

export type RunSinglePhaseParams = Readonly<{
  provider: AgentProvider;
  workflowName: string;
  phaseName: string;
  workflowsDir: string;
  promptsDir: string;
  stateDir: string;
  cwd: string;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
}>;

export async function runSinglePhaseOnce(params: RunSinglePhaseParams): Promise<{ phase: string; success: boolean }> {
  const runDbContext = resolveRunDbContextFromEnv();
  const workflow = await loadWorkflowByName(params.workflowName, { workflowsDir: params.workflowsDir });
  const engine = new WorkflowEngine(workflow);

  const phase = params.phaseName;
  const phaseType = engine.getPhaseType(phase);
  if (!phaseType) throw new Error(`Unknown phase: ${phase}`);

  const outputPath = path.join(params.stateDir, 'sdk-output.json');
  const logPath = path.join(params.stateDir, 'last-run.log');
  const progressPath = path.join(params.stateDir, 'progress.txt');

  if (engine.isTerminal(phase)) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await ensureProgressFile(progressPath);
    await markStarted(progressPath);
    await markPhase(progressPath, phase);
    await fs.writeFile(logPath, '', 'utf-8');
    const writer = new SdkOutputWriterV1({
      outputPath,
      dbContext: runDbContext,
    });
    writer.finalize(true);
    await writer.writeIncremental({ force: true });
    await markEnded(progressPath, true);
    return { phase, success: true };
  }

  const promptPath = await resolvePromptPath(phase, params.promptsDir, engine);
  const phaseConfig = workflow.phases[phase];
  const result = await runPhaseOnce({
    provider: params.provider,
    promptPath,
    outputPath,
    logPath,
    progressPath,
    stateDir: params.stateDir,
    cwd: params.cwd,
    phaseName: phase,
    mcpServers: params.mcpServers,
    mcpProfile: phaseConfig?.mcpProfile,
    permissionMode: phaseConfig?.permissionMode,
  });

  // After plan-mode phases, extract assistant output and persist as task-plan.md
  if (result.success && phaseConfig?.permissionMode === 'plan') {
    try {
      const raw = await fs.readFile(outputPath, 'utf-8');
      const planText = extractTaskPlanFromSdkOutput(raw);
      if (planText.trim()) {
        const planPath = path.join(params.stateDir, 'task-plan.md');
        await fs.writeFile(planPath, planText, 'utf-8');
      }
    } catch {
      // Plan extraction is best-effort; don't fail the phase
    }
  }

  return { phase, success: result.success };
}
