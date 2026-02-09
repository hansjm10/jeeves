import { query } from '@anthropic-ai/claude-agent-sdk';
import type { MemoryEntry } from '@jeeves/state-db';

const REFLECTION_MODEL = 'claude-haiku-4-5-20251001';
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const MAX_TEXT_LENGTH = 260;
const MAX_VALUE_STRINGS = 80;
const MAX_VALUE_DEPTH = 4;
const MIN_TOKEN_MATCH_COUNT = 2;

type JsonRecord = Record<string, unknown>;

export type ReflectionTask = Readonly<{
  id: string;
  title: string;
  status: string;
}>;

export type ReflectionSnapshot = Readonly<{
  current_objective: string;
  open_hypotheses: string[];
  blockers: string[];
  next_actions: string[];
  unresolved_questions: string[];
  required_evidence_links: string[];
}>;

export type ReflectionDroppedItem = Readonly<{
  value: string;
  reason: string;
}>;

export type ReflectionDiagnostics = Readonly<{
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  dropped: ReflectionDroppedItem[];
}>;

export type ReflectTrajectoryResult = Readonly<{
  snapshot: ReflectionSnapshot;
  diagnostics: ReflectionDiagnostics;
}>;

export type ReflectionErrorCode =
  | 'api_error'
  | 'invalid_json'
  | 'validation_failed'
  | 'no_assistant_output';

export class TrajectoryReflectionError extends Error {
  readonly code: ReflectionErrorCode;
  readonly diagnostics: ReflectionDiagnostics;

  constructor(params: {
    code: ReflectionErrorCode;
    message: string;
    diagnostics: ReflectionDiagnostics;
  }) {
    super(params.message);
    this.name = 'TrajectoryReflectionError';
    this.code = params.code;
    this.diagnostics = params.diagnostics;
  }
}

type ReflectionQueryInput = Readonly<{
  prompt: string;
  options: Record<string, unknown>;
}>;

export type ReflectionQueryFn = (input: ReflectionQueryInput) => AsyncIterable<unknown>;

type ReflectTrajectoryParams = Readonly<{
  objective: string;
  memoryEntries: readonly MemoryEntry[];
  previousSnapshot: ReflectionSnapshot | null;
  tasks: readonly ReflectionTask[];
  cwd?: string;
  model?: string;
  queryFn?: ReflectionQueryFn;
  nowMs?: () => number;
}>;

function isPlainRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > MAX_TEXT_LENGTH
    ? `${normalized.slice(0, MAX_TEXT_LENGTH)}...`
    : normalized;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (out.length >= MAX_VALUE_STRINGS) return;
  if (depth > MAX_VALUE_DEPTH) return;
  const text = normalizeText(value);
  if (text) {
    out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

function dedupeList(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const normalized = normalizeText(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function estimateTokenSize(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenizeForMatch(text: string): string[] {
  const out = text.toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length >= 4);
  return dedupeList(out);
}

function buildPreviousSnapshotSummary(snapshot: ReflectionSnapshot | null): string {
  if (!snapshot) return '(none)';
  return JSON.stringify(snapshot, null, 2);
}

function toPromptMemoryEntries(entries: readonly MemoryEntry[]): readonly JsonRecord[] {
  return entries.map((entry) => ({
    scope: entry.scope,
    key: entry.key,
    value: entry.value,
    sourceIteration: entry.sourceIteration,
  }));
}

function toPromptTasks(tasks: readonly ReflectionTask[]): readonly JsonRecord[] {
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
  }));
}

export function buildTrajectoryReflectionPrompt(params: {
  objective: string;
  memoryEntries: readonly MemoryEntry[];
  previousSnapshot: ReflectionSnapshot | null;
  tasks: readonly ReflectionTask[];
}): string {
  const memoryEntriesJson = JSON.stringify(toPromptMemoryEntries(params.memoryEntries), null, 2);
  const tasksJson = JSON.stringify(toPromptTasks(params.tasks), null, 2);

  return [
    'You are a trajectory reduction assistant. Given an agent\'s current objective',
    'and its memory entries, categorize each entry into the appropriate field',
    'of an active context snapshot.',
    '',
    '## Current Objective',
    params.objective,
    '',
    '## Previous Snapshot',
    buildPreviousSnapshotSummary(params.previousSnapshot),
    '',
    '## Memory Entries',
    memoryEntriesJson,
    '',
    '## Task Statuses',
    tasksJson,
    '',
    '## Instructions',
    '1. Categorize each memory entry into exactly one of:',
    '   - open_hypotheses: Active theories being tested',
    '   - blockers: Issues currently preventing progress',
    '   - next_actions: Concrete steps to take next',
    '   - unresolved_questions: Open questions needing answers',
    '   - required_evidence_links: URLs, file paths, or artifact references',
    '   - irrelevant: Safe to exclude from the snapshot',
    '',
    '2. Consolidate semantically-similar items into a single entry.',
    '',
    '3. For items marked irrelevant, briefly note why (resolved, superseded, stale).',
    '',
    '4. Set current_objective to a concise summary of the primary goal.',
    '',
    '5. Do NOT invent information not present in the entries or tasks.',
    '',
    '## Output Format (strict JSON)',
    '{',
    '  "current_objective": "string",',
    '  "open_hypotheses": ["string", "..."],',
    '  "blockers": ["string", "..."],',
    '  "next_actions": ["string", "..."],',
    '  "unresolved_questions": ["string", "..."],',
    '  "required_evidence_links": ["string", "..."],',
    '  "dropped": [{"value": "string", "reason": "string"}]',
    '}',
  ].join('\n');
}

function extractAssistantTextFromEvent(event: unknown): string | null {
  if (!isPlainRecord(event) || event.type !== 'assistant') return null;
  const message = event.message;
  if (typeof message === 'string') return message.trim() || null;
  if (!isPlainRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainRecord(block)) continue;
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') continue;
    parts.push(block.text);
  }
  if (parts.length === 0) return null;
  return parts.join('').trim() || null;
}

function extractUsageFromEvent(event: unknown): Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
}> | null {
  if (!isPlainRecord(event) || event.type !== 'result') return null;
  const usage = isPlainRecord(event.usage) ? event.usage : null;
  if (!usage) return null;

  const inputTokens = typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
    ? Math.max(0, Math.trunc(usage.input_tokens))
    : null;
  const outputTokens = typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
    ? Math.max(0, Math.trunc(usage.output_tokens))
    : null;

  return { inputTokens, outputTokens };
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return trimmed;
}

function parseJsonRecord(raw: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return dedupeList(
    value
      .map((entry) => normalizeText(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

function parseDropped(value: unknown): ReflectionDroppedItem[] {
  if (!Array.isArray(value)) return [];
  const out: ReflectionDroppedItem[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue;
    const droppedValue = normalizeText(entry.value);
    const reason = normalizeText(entry.reason);
    if (!droppedValue || !reason) continue;
    out.push({ value: droppedValue, reason });
  }
  return out;
}

function parseReflectionResponse(raw: string): Readonly<{
  snapshot: ReflectionSnapshot;
  dropped: ReflectionDroppedItem[];
}> {
  const candidate = extractJsonCandidate(raw);
  const parsed = parseJsonRecord(candidate);
  if (!parsed) throw new Error('Could not parse reflection response JSON.');

  const currentObjective = normalizeText(parsed.current_objective);
  if (!currentObjective) throw new Error('Missing current_objective in reflection response.');

  return {
    snapshot: {
      current_objective: currentObjective,
      open_hypotheses: asStringList(parsed.open_hypotheses),
      blockers: asStringList(parsed.blockers),
      next_actions: asStringList(parsed.next_actions),
      unresolved_questions: asStringList(parsed.unresolved_questions),
      required_evidence_links: asStringList(parsed.required_evidence_links),
    },
    dropped: parseDropped(parsed.dropped),
  };
}

function collectSourceTexts(params: {
  objective: string;
  previousSnapshot: ReflectionSnapshot | null;
  memoryEntries: readonly MemoryEntry[];
  tasks: readonly ReflectionTask[];
}): string[] {
  const out: string[] = [];
  const objective = normalizeText(params.objective);
  if (objective) out.push(objective);

  if (params.previousSnapshot) {
    out.push(params.previousSnapshot.current_objective);
    out.push(...params.previousSnapshot.open_hypotheses);
    out.push(...params.previousSnapshot.blockers);
    out.push(...params.previousSnapshot.next_actions);
    out.push(...params.previousSnapshot.unresolved_questions);
    out.push(...params.previousSnapshot.required_evidence_links);
  }

  for (const task of params.tasks) {
    out.push(`${task.id} ${task.title} ${task.status}`);
  }

  for (const entry of params.memoryEntries) {
    out.push(`${entry.scope} ${entry.key}`);
    const strings: string[] = [];
    collectStrings(entry.value, strings);
    if (strings.length === 0) {
      out.push(compactJson(entry.value));
      continue;
    }
    out.push(...strings);
  }

  return dedupeList(out);
}

function itemMatchesSource(
  item: string,
  normalizedSources: readonly string[],
  sourceTokenSet: ReadonlySet<string>,
): boolean {
  const normalizedItem = normalizeForMatch(item);
  if (!normalizedItem) return false;

  for (const source of normalizedSources) {
    if (source.includes(normalizedItem)) return true;
    if (normalizedItem.length >= 16 && normalizedItem.includes(source)) return true;
  }

  const tokens = tokenizeForMatch(normalizedItem);
  if (tokens.length === 0) return false;
  let matchedTokens = 0;
  for (const token of tokens) {
    if (!sourceTokenSet.has(token)) continue;
    matchedTokens += 1;
    if (matchedTokens >= Math.min(MIN_TOKEN_MATCH_COUNT, tokens.length)) return true;
  }
  return false;
}

function validateReflectedSnapshot(params: {
  reflected: ReflectionSnapshot;
  sourceTexts: readonly string[];
}): void {
  const normalizedSources = params.sourceTexts.map((entry) => normalizeForMatch(entry)).filter(Boolean);
  const sourceTokenSet = new Set<string>();
  for (const source of normalizedSources) {
    for (const token of tokenizeForMatch(source)) sourceTokenSet.add(token);
  }

  const fields: readonly [string, readonly string[]][] = [
    ['open_hypotheses', params.reflected.open_hypotheses],
    ['blockers', params.reflected.blockers],
    ['next_actions', params.reflected.next_actions],
    ['unresolved_questions', params.reflected.unresolved_questions],
    ['required_evidence_links', params.reflected.required_evidence_links],
  ];

  for (const [fieldName, values] of fields) {
    for (const value of values) {
      if (itemMatchesSource(value, normalizedSources, sourceTokenSet)) continue;
      throw new Error(`Reflected ${fieldName} item does not trace to source data: "${value}"`);
    }
  }
}

function createDiagnostics(params: {
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  dropped: readonly ReflectionDroppedItem[];
}): ReflectionDiagnostics {
  return {
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    latency_ms: params.latencyMs,
    dropped: [...params.dropped],
  };
}

function buildReflectionQueryOptions(params: {
  cwd?: string;
  model: string;
}): Record<string, unknown> {
  const canUseTool = async (
    _toolName: string,
    _input: Record<string, unknown>,
    permissionOptions?: { toolUseID?: string },
  ): Promise<{ behavior: 'deny'; message: string; toolUseID?: string }> => ({
    behavior: 'deny',
    message: 'Tool use is disabled for trajectory reflection.',
    ...(permissionOptions?.toolUseID ? { toolUseID: permissionOptions.toolUseID } : {}),
  });

  return {
    ...(params.cwd ? { cwd: params.cwd } : {}),
    model: params.model,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    canUseTool,
  };
}

const defaultReflectionQueryFn: ReflectionQueryFn = (input) =>
  query(input as Parameters<typeof query>[0]) as AsyncIterable<unknown>;

export async function reflectTrajectory(
  params: ReflectTrajectoryParams,
): Promise<ReflectTrajectoryResult> {
  const nowMs = params.nowMs ?? Date.now;
  const runQuery = params.queryFn ?? defaultReflectionQueryFn;
  const model = params.model ?? REFLECTION_MODEL;

  const prompt = buildTrajectoryReflectionPrompt({
    objective: params.objective,
    memoryEntries: params.memoryEntries,
    previousSnapshot: params.previousSnapshot,
    tasks: params.tasks,
  });
  const startMs = nowMs();

  const assistantChunks: string[] = [];
  let usageInputTokens: number | null = null;
  let usageOutputTokens: number | null = null;
  try {
    const stream = runQuery({
      prompt,
      options: buildReflectionQueryOptions({
        cwd: params.cwd,
        model,
      }),
    });
    for await (const event of stream) {
      const assistantChunk = extractAssistantTextFromEvent(event);
      if (assistantChunk) assistantChunks.push(assistantChunk);

      const usage = extractUsageFromEvent(event);
      if (usage) {
        usageInputTokens = usage.inputTokens;
        usageOutputTokens = usage.outputTokens;
      }
    }
  } catch (err) {
    const latencyMs = Math.max(0, nowMs() - startMs);
    const message = err instanceof Error ? err.message : String(err);
    throw new TrajectoryReflectionError({
      code: 'api_error',
      message: `Reflection query failed: ${message}`,
      diagnostics: createDiagnostics({
        inputTokens: usageInputTokens ?? estimateTokenSize(prompt),
        outputTokens: usageOutputTokens,
        latencyMs,
        dropped: [],
      }),
    });
  }

  const latencyMs = Math.max(0, nowMs() - startMs);
  if (assistantChunks.length === 0) {
    throw new TrajectoryReflectionError({
      code: 'no_assistant_output',
      message: 'Reflection query completed without assistant output.',
      diagnostics: createDiagnostics({
        inputTokens: usageInputTokens ?? estimateTokenSize(prompt),
        outputTokens: usageOutputTokens,
        latencyMs,
        dropped: [],
      }),
    });
  }

  const assistantRaw = assistantChunks.join('\n\n').trim();
  let parsed: Readonly<{ snapshot: ReflectionSnapshot; dropped: ReflectionDroppedItem[] }>;
  try {
    parsed = parseReflectionResponse(assistantRaw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TrajectoryReflectionError({
      code: 'invalid_json',
      message: `Invalid reflection response: ${message}`,
      diagnostics: createDiagnostics({
        inputTokens: usageInputTokens ?? estimateTokenSize(prompt),
        outputTokens: usageOutputTokens ?? estimateTokenSize(assistantRaw),
        latencyMs,
        dropped: [],
      }),
    });
  }

  try {
    validateReflectedSnapshot({
      reflected: parsed.snapshot,
      sourceTexts: collectSourceTexts({
        objective: params.objective,
        previousSnapshot: params.previousSnapshot,
        memoryEntries: params.memoryEntries,
        tasks: params.tasks,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TrajectoryReflectionError({
      code: 'validation_failed',
      message: `Invalid reflection output: ${message}`,
      diagnostics: createDiagnostics({
        inputTokens: usageInputTokens ?? estimateTokenSize(prompt),
        outputTokens: usageOutputTokens ?? estimateTokenSize(assistantRaw),
        latencyMs,
        dropped: parsed.dropped,
      }),
    });
  }

  return {
    snapshot: parsed.snapshot,
    diagnostics: createDiagnostics({
      inputTokens: usageInputTokens ?? estimateTokenSize(prompt),
      outputTokens: usageOutputTokens ?? estimateTokenSize(assistantRaw),
      latencyMs,
      dropped: parsed.dropped,
    }),
  };
}
