import fs from 'node:fs/promises';
import path from 'node:path';

import { loadWorkflowByName, resolvePromptPath, WorkflowEngine } from '@jeeves/core';
import {
  appendRunLogLine,
  dbPathForDataDir,
  deriveDataDirFromStateDir,
  listMemoryEntriesFromDb,
  type MemoryEntry,
  upsertRunSession,
} from '@jeeves/state-db';

import { ensureJeevesExcludedFromGitStatus } from './gitExclude.js';
import { buildMcpServersConfig } from './mcpConfig.js';
import type { AgentProvider, McpServerConfig } from './provider.js';
import { appendProgress, ensureProgressFile, markEnded, markPhase, markStarted } from './progress.js';
import { SdkOutputWriterV1 } from './outputWriter.js';

const PREPENDED_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const MAX_PROMPT_MEMORY_ENTRIES = 500;

function memoryScopeRank(scope: MemoryEntry['scope']): number {
  if (scope === 'working_set') return 1;
  if (scope === 'decisions') return 2;
  if (scope === 'session') return 3;
  return 4;
}

function compareMemoryEntries(a: MemoryEntry, b: MemoryEntry): number {
  const scopeDiff = memoryScopeRank(a.scope) - memoryScopeRank(b.scope);
  if (scopeDiff !== 0) return scopeDiff;

  const keyDiff = a.key.localeCompare(b.key);
  if (keyDiff !== 0) return keyDiff;

  const updatedDiff = a.updatedAt.localeCompare(b.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;

  return a.stateDir.localeCompare(b.stateDir);
}

function deriveCanonicalStateDirFromWorkerStateDir(stateDir: string): string | null {
  const resolved = path.resolve(stateDir);
  const marker = `${path.sep}.runs${path.sep}`;
  const markerIdx = resolved.lastIndexOf(marker);
  if (markerIdx === -1) return null;

  const suffix = resolved.slice(markerIdx + marker.length).split(path.sep).filter((segment) => segment.length > 0);
  if (suffix.length < 3 || suffix[1] !== 'workers') return null;

  const canonical = resolved.slice(0, markerIdx);
  return canonical || null;
}

function listMemoryStateDirsForPrompt(stateDir: string): string[] {
  const resolved = path.resolve(stateDir);
  const canonical = deriveCanonicalStateDirFromWorkerStateDir(resolved);
  if (!canonical || canonical === resolved) return [resolved];
  return [resolved, canonical];
}

function listScopedMemoryEntriesForPrompt(stateDir: string): MemoryEntry[] {
  const stateDirs = listMemoryStateDirsForPrompt(stateDir);
  const merged = new Map<string, MemoryEntry>();

  for (const dir of stateDirs) {
    const entries = listMemoryEntriesFromDb({
      stateDir: dir,
      includeStale: false,
      limit: null,
    });
    for (const entry of entries) {
      const entryId = `${entry.scope}\u0000${entry.key}`;
      if (!merged.has(entryId)) {
        merged.set(entryId, entry);
      }
    }
  }

  return [...merged.values()].sort(compareMemoryEntries);
}

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
  mcpEnforcement?: string;
  permissionMode?: string;
}>;

type RunDbContext = Readonly<{
  dataDir: string;
  runId: string;
  scope: string;
  taskId: string;
}>;

function nowIso(): string {
  return new Date().toISOString();
}

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

type NormalizedMcpProfile = 'default' | 'none' | 'pruner' | 'state' | 'state_with_pruner';
type McpEnforcementMode = 'strict' | 'allow_degraded' | 'off';

function normalizeMcpProfileForEnforcement(raw: string | undefined): NormalizedMcpProfile {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'default';
  if (value === 'none') return 'none';
  if (value === 'pruner') return 'pruner';
  if (value === 'state') return 'state';
  if (value === 'state_with_pruner' || value === 'state+pruner' || value === 'state-pruner') {
    return 'state_with_pruner';
  }
  return 'default';
}

function requiredMcpServersForProfile(profile: NormalizedMcpProfile): string[] {
  if (profile === 'pruner') return ['pruner'];
  if (profile === 'state') return ['state'];
  if (profile === 'state_with_pruner') return ['state', 'pruner'];
  return [];
}

function normalizeMcpEnforcementMode(
  raw: string | undefined,
  profile: NormalizedMcpProfile,
): McpEnforcementMode {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'strict') return 'strict';
  if (
    normalized === 'allow_degraded' ||
    normalized === 'allow-degraded' ||
    normalized === 'degraded'
  ) {
    return 'allow_degraded';
  }

  if (profile === 'state' || profile === 'pruner' || profile === 'state_with_pruner') {
    return 'strict';
  }
  return 'off';
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

function toPhaseHints(value: Record<string, unknown>): readonly string[] {
  const hints = new Set<string>();
  const addString = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const normalized = raw.trim().toLowerCase();
    if (normalized) hints.add(normalized);
  };
  const addStringArray = (raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) addString(item);
  };

  addString(value['phase']);
  addString(value['phaseName']);
  addStringArray(value['phases']);
  addStringArray(value['phaseNames']);
  addStringArray(value['relevantPhases']);
  return [...hints];
}

function isPhaseTaggedInKey(key: string, phaseName: string): boolean {
  const normalizedKey = key.trim().toLowerCase();
  const normalizedPhase = phaseName.trim().toLowerCase();
  if (!normalizedKey || !normalizedPhase) return false;
  return (
    normalizedKey === normalizedPhase ||
    normalizedKey.startsWith(`${normalizedPhase}:`) ||
    normalizedKey.endsWith(`:${normalizedPhase}`) ||
    normalizedKey.includes(`:${normalizedPhase}:`)
  );
}

function isSessionMemoryRelevant(entry: MemoryEntry, phaseName: string): boolean {
  const normalizedPhase = phaseName.trim().toLowerCase();
  if (!normalizedPhase) return false;
  const hints = toPhaseHints(entry.value);
  if (hints.length > 0) return hints.includes(normalizedPhase);
  return isPhaseTaggedInKey(entry.key, normalizedPhase);
}

function isCrossRunMemoryRelevant(entry: MemoryEntry, phaseName: string): boolean {
  const alwaysRelevant = entry.value['alwaysRelevant'] === true || entry.value['always'] === true;
  if (alwaysRelevant) return true;
  const hints = toPhaseHints(entry.value);
  const normalizedPhase = phaseName.trim().toLowerCase();
  if (hints.includes(normalizedPhase)) return true;
  return isPhaseTaggedInKey(entry.key, phaseName);
}

function compactJsonRecord(value: Record<string, unknown>, maxChars = 800): string {
  const raw = JSON.stringify(value);
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}...[truncated]`;
}

function formatMemoryEntry(entry: MemoryEntry): string {
  const sourceIteration = entry.sourceIteration === null ? 'n/a' : String(entry.sourceIteration);
  const valueText = compactJsonRecord(entry.value);
  return `- key=${entry.key} source_iteration=${sourceIteration} updated_at=${entry.updatedAt} value=${valueText}`;
}

function formatMemorySection(title: string, entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return `### ${title}\n- (none)`;
  return `### ${title}\n${entries.map((entry) => formatMemoryEntry(entry)).join('\n')}`;
}

function buildScopedMemoryBlock(stateDir: string, phaseName: string): string {
  const entries = listScopedMemoryEntriesForPrompt(stateDir);

  const relevantEntries = entries.filter((entry) => {
    if (entry.scope === 'session') return isSessionMemoryRelevant(entry, phaseName);
    if (entry.scope === 'cross_run') return isCrossRunMemoryRelevant(entry, phaseName);
    return true;
  });
  const limitedEntries = relevantEntries.slice(0, MAX_PROMPT_MEMORY_ENTRIES);

  const workingSet = limitedEntries.filter((entry) => entry.scope === 'working_set');
  const decisions = limitedEntries.filter((entry) => entry.scope === 'decisions');
  const session = limitedEntries.filter((entry) => entry.scope === 'session');
  const crossRun = limitedEntries.filter((entry) => entry.scope === 'cross_run');

  const sections: string[] = [
    formatMemorySection('Working Set (active)', workingSet),
    formatMemorySection('Decisions (active)', decisions),
  ];
  if (session.length > 0) {
    sections.push(formatMemorySection(`Session Context (phase=${phaseName})`, session));
  }
  if (crossRun.length > 0) {
    sections.push(formatMemorySection('Cross-Run Memory (relevant)', crossRun));
  }

  return [
    '<memory_context>',
    'Use these structured memory entries as primary context before replaying progress history.',
    sections.join('\n\n'),
    '</memory_context>',
  ].join('\n\n');
}

type MemoryBlockResult = Readonly<{
  block: string;
  enabled: boolean;
  reason: string;
}>;

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return String(err);
}

async function buildScopedMemoryBlockIfAvailable(stateDir: string, phaseName: string): Promise<MemoryBlockResult> {
  const dbPath = dbPathForDataDir(deriveDataDirFromStateDir(stateDir));
  try {
    const stat = await fs.stat(dbPath);
    if (!stat.isFile()) {
      return { block: '', enabled: false, reason: `state_db_unavailable path=${dbPath}` };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { block: '', enabled: false, reason: `state_db_unavailable path=${dbPath}` };
    }
    return { block: '', enabled: false, reason: `state_db_unavailable path=${dbPath} error=${formatErrorMessage(err)}` };
  }

  try {
    return {
      block: buildScopedMemoryBlock(stateDir, phaseName),
      enabled: true,
      reason: `state_db_available path=${dbPath}`,
    };
  } catch (err) {
    return { block: '', enabled: false, reason: `state_db_read_failed path=${dbPath} error=${formatErrorMessage(err)}` };
  }
}

async function buildPromptWithPrependedInstructions(
  phasePrompt: string,
  cwd: string,
  memoryBlock: string,
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

  if (memoryBlock.trim()) {
    sections.push(memoryBlock.trim());
  }

  if (sections.length === 0) {
    return { prompt: phasePrompt, prependedFiles };
  }

  const preface = [
    '<workspace_instructions>',
    'The following repository instructions and structured memory context are prepended for this run.',
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
  await fs.rm(path.join(path.dirname(params.outputPath), 'tool-raw'), { recursive: true, force: true }).catch(() => void 0);
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

  const phasePrompt = await fs.readFile(params.promptPath, 'utf-8');
  const memoryBlockResult = await buildScopedMemoryBlockIfAvailable(params.stateDir, params.phaseName);
  const { prompt, prependedFiles } = await buildPromptWithPrependedInstructions(
    phasePrompt,
    params.cwd,
    memoryBlockResult.block,
  );

  await markStarted(params.progressPath);
  await markPhase(params.progressPath, params.phaseName);

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
    await logLine(
      `[RUNNER] memory_context=${memoryBlockResult.enabled ? 'enabled' : 'disabled'} ${memoryBlockResult.reason}`,
    );

    const mcpServers = params.mcpServers ?? buildMcpServersConfig(process.env, params.cwd, {
      stateDir: params.stateDir,
      profile: params.mcpProfile,
    });
    const normalizedMcpProfile = normalizeMcpProfileForEnforcement(params.mcpProfile);
    const requiredMcpServers = requiredMcpServersForProfile(normalizedMcpProfile);
    const enforcementMode = normalizeMcpEnforcementMode(params.mcpEnforcement, normalizedMcpProfile);
    const availableMcpServers = mcpServers ? Object.keys(mcpServers).sort() : [];
    const missingMcpServers = requiredMcpServers.filter((serverName) => !(mcpServers && mcpServers[serverName]));

    if (requiredMcpServers.length > 0) {
      await logLine(
        `[MCP] profile=${normalizedMcpProfile} enforcement=${enforcementMode} required=${requiredMcpServers.join(',')} available=${availableMcpServers.join(',') || 'none'}`,
      );
    }

    if (missingMcpServers.length > 0) {
      const missingMessage =
        `Missing required MCP servers (${missingMcpServers.join(', ')}) for profile ` +
        `'${normalizedMcpProfile}' in phase '${params.phaseName}'.`;

      if (enforcementMode === 'allow_degraded') {
        await logLine(`[MCP] DEGRADED_MODE ${missingMessage} Continuing with reduced tool set.`);
        writer.addProviderEvent({
          type: 'system',
          subtype: 'error',
          content: `[mcp] degraded mode: ${missingMessage}`,
          timestamp: nowIso(),
        });
      } else if (enforcementMode === 'strict') {
        await logLine(`[MCP] FAIL_FAST ${missingMessage}`);
        writer.addProviderEvent({
          type: 'system',
          subtype: 'error',
          content: `[mcp] fail-fast: ${missingMessage}`,
          timestamp: nowIso(),
        });
        throw new Error(`[MCP_ENFORCEMENT] ${missingMessage}`);
      }
    }

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
      mcpEnforcement: workflow.phases[current]?.mcpEnforcement,
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
    mcpEnforcement: phaseConfig?.mcpEnforcement,
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
