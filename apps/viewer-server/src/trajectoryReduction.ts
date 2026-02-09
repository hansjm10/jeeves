import fs from 'node:fs/promises';
import path from 'node:path';

import { listMemoryEntriesFromDb, type MemoryEntry } from '@jeeves/state-db';

import { writeJsonAtomic } from './jsonAtomic.js';
import { renderProgressText } from './sqliteStorage.js';

export const ACTIVE_CONTEXT_FILE = 'active-context.json';
export const RETIRED_TRAJECTORY_FILE = 'retired-trajectory.jsonl';
const TRAJECTORY_REDUCTION_FILE = 'trajectory-reduction.json';

const URL_REGEX = /https?:\/\/[^\s)"']+/g;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
const MAX_CATEGORY_ITEMS = 25;
const MAX_TEXT_LENGTH = 260;
const MAX_VALUE_STRINGS = 80;
const MAX_VALUE_DEPTH = 4;

type JsonRecord = Record<string, unknown>;

type SnapshotField =
  | 'current_objective'
  | 'open_hypotheses'
  | 'blockers'
  | 'next_actions'
  | 'unresolved_questions'
  | 'required_evidence_links';

export type ActiveContextSnapshot = Readonly<{
  schema_version: 1;
  generated_at: string;
  iteration: number;
  current_objective: string;
  open_hypotheses: string[];
  blockers: string[];
  next_actions: string[];
  unresolved_questions: string[];
  required_evidence_links: string[];
}>;

export type RetiredTrajectoryRecord = Readonly<{
  schema_version: 1;
  retired_at: string;
  iteration: number;
  previous_iteration: number | null;
  field: SnapshotField;
  value: string;
  reason: 'no_longer_active';
}>;

export type TrajectoryReductionDiagnostics = Readonly<{
  schema_version: 1;
  generated_at: string;
  iteration: number;
  active_snapshot_token_size: number;
  retired_branch_count: number;
  repeated_context_rate: number;
  active_item_count: number;
  repeated_item_count: number;
  warnings: string[];
}>;

export type TrajectoryReductionSummary = Readonly<{
  schema_version: 1;
  iterations_with_reduction: number;
  total_retired_branch_count: number;
  max_active_snapshot_token_size: number;
  avg_repeated_context_rate: number;
  max_repeated_context_rate: number;
}>;

export type TrajectoryReductionResult = Readonly<{
  snapshot: ActiveContextSnapshot;
  retired: RetiredTrajectoryRecord[];
  diagnostics: TrajectoryReductionDiagnostics;
}>;

function isPlainRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > MAX_TEXT_LENGTH
    ? `${normalized.slice(0, MAX_TEXT_LENGTH)}...`
    : normalized;
}

function toComparableKey(input: string): string {
  return input.trim().toLowerCase();
}

function dedupeList(
  values: readonly string[],
  options?: {
    maxItems?: number | null;
  },
): string[] {
  const maxItems = options?.maxItems === undefined ? MAX_CATEGORY_ITEMS : options.maxItems;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const normalized = normalizeText(raw);
    if (!normalized) continue;
    const key = toComparableKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (maxItems !== null && out.length >= maxItems) break;
  }
  return out;
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

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readJsonRecord(raw: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsonRecordFromFile(filePath: string): Promise<JsonRecord | null> {
  const raw = await fs.readFile(filePath, 'utf-8').catch(() => null);
  if (!raw) return null;
  return readJsonRecord(raw);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function parseActiveContextSnapshot(value: unknown): ActiveContextSnapshot | null {
  if (!isPlainRecord(value)) return null;
  if (value.schema_version !== 1) return null;
  if (typeof value.generated_at !== 'string') return null;
  if (typeof value.iteration !== 'number' || !Number.isFinite(value.iteration)) return null;
  const objective = normalizeText(value.current_objective);
  if (!objective) return null;
  return {
    schema_version: 1,
    generated_at: value.generated_at,
    iteration: Math.trunc(value.iteration),
    current_objective: objective,
    open_hypotheses: asStringArray(value.open_hypotheses),
    blockers: asStringArray(value.blockers),
    next_actions: asStringArray(value.next_actions),
    unresolved_questions: asStringArray(value.unresolved_questions),
    required_evidence_links: asStringArray(value.required_evidence_links),
  };
}

async function readPreviousSnapshot(stateDir: string): Promise<ActiveContextSnapshot | null> {
  const raw = await fs.readFile(path.join(stateDir, ACTIVE_CONTEXT_FILE), 'utf-8').catch(() => null);
  if (!raw) return null;
  const parsed = readJsonRecord(raw);
  if (!parsed) return null;
  return parseActiveContextSnapshot(parsed);
}

function objectiveFromIssue(issue: JsonRecord | null): string {
  if (!issue) return 'Advance the current issue workflow safely.';
  const status = isPlainRecord(issue.status) ? issue.status : null;
  const issueObj = isPlainRecord(issue.issue) ? issue.issue : null;

  const direct = [
    status?.currentObjective,
    issue.current_objective,
    issue.objective,
    issue.summary,
    issueObj?.title,
    issue.title,
  ];
  for (const candidate of direct) {
    const normalized = normalizeText(candidate);
    if (normalized) return normalized;
  }

  const phase = normalizeText(issue.phase);
  if (phase) return `Complete the current phase: ${phase}.`;
  return 'Advance the current issue workflow safely.';
}

type NormalizedTask = Readonly<{
  id: string;
  title: string;
  status: string;
}>;

function normalizeTasks(tasksPayload: JsonRecord | null): NormalizedTask[] {
  if (!tasksPayload) return [];
  const rawTasks = tasksPayload.tasks;
  if (!Array.isArray(rawTasks)) return [];
  const tasks: NormalizedTask[] = [];
  for (const raw of rawTasks) {
    if (!isPlainRecord(raw)) continue;
    const id = normalizeText(raw.id) ?? normalizeText(raw.taskId) ?? 'unknown-task';
    const title = normalizeText(raw.title) ?? normalizeText(raw.summary) ?? id;
    const status = normalizeText(raw.status)?.toLowerCase() ?? 'unknown';
    tasks.push({ id, title, status });
  }
  return tasks;
}

function isLikelyHypothesis(text: string): boolean {
  return /\b(hypothesis|assumption|approach|candidate|option|theory)\b/i.test(text);
}

function isLikelyBlocker(text: string): boolean {
  return /\b(blocker|blocked|risk|dependency|waiting|failure|error|stuck)\b/i.test(text);
}

function isLikelyNextAction(text: string): boolean {
  return /\b(next|todo|action|follow[\s_-]?up|implement|verify|test|ship)\b/i.test(text);
}

function isLikelyQuestion(text: string): boolean {
  return /\b(question|unknown|unclear|clarify|tbd)\b/i.test(text) || text.includes('?');
}

function collectEvidenceLinksFromText(raw: string, out: Set<string>): void {
  for (const match of raw.matchAll(URL_REGEX)) {
    const normalized = normalizeText(match[0]);
    if (normalized) out.add(normalized);
  }
  const retrievalMatches = raw.match(/tool-output:\/\/[A-Za-z0-9._-]+/g) ?? [];
  for (const entry of retrievalMatches) {
    const normalized = normalizeText(entry);
    if (normalized) out.add(normalized);
  }
}

function collectEvidenceLinksFromValue(value: unknown, out: Set<string>): void {
  const strings: string[] = [];
  collectStrings(value, strings);
  for (const entry of strings) collectEvidenceLinksFromText(entry, out);
}

function memoryEntrySummary(entry: MemoryEntry): string {
  const strings: string[] = [];
  collectStrings(entry.value, strings);
  const preview = strings[0] ?? compactJson(entry.value);
  const normalized = normalizeText(preview) ?? '(no details)';
  return `${entry.scope}:${entry.key} - ${normalized}`;
}

function collectCategoryFromMemory(entries: readonly MemoryEntry[]): {
  openHypotheses: string[];
  blockers: string[];
  nextActions: string[];
  unresolvedQuestions: string[];
  evidenceLinks: string[];
} {
  const openHypotheses: string[] = [];
  const blockers: string[] = [];
  const nextActions: string[] = [];
  const unresolvedQuestions: string[] = [];
  const evidenceLinks = new Set<string>();

  for (const entry of entries) {
    const strings: string[] = [];
    collectStrings(entry.value, strings);
    const searchText = [entry.scope, entry.key, ...strings].join(' ');
    const summary = memoryEntrySummary(entry);

    if (isLikelyHypothesis(searchText)) openHypotheses.push(summary);
    if (isLikelyBlocker(searchText)) blockers.push(summary);
    if (isLikelyNextAction(searchText)) nextActions.push(summary);
    if (isLikelyQuestion(searchText)) unresolvedQuestions.push(summary);
    collectEvidenceLinksFromValue(entry.value, evidenceLinks);
  }

  return {
    openHypotheses: dedupeList(openHypotheses),
    blockers: dedupeList(blockers),
    nextActions: dedupeList(nextActions),
    unresolvedQuestions: dedupeList(unresolvedQuestions),
    evidenceLinks: dedupeList([...evidenceLinks]),
  };
}

function collectTaskDerivedContext(tasksPayload: JsonRecord | null): {
  blockers: string[];
  nextActions: string[];
} {
  const blockers: string[] = [];
  const nextActions: string[] = [];
  const tasks = normalizeTasks(tasksPayload);

  for (const task of tasks) {
    if (task.status === 'failed' || task.status === 'blocked') {
      blockers.push(`Task ${task.id} (${task.title}) is ${task.status}`);
      continue;
    }
    if (
      task.status === 'pending' ||
      task.status === 'todo' ||
      task.status === 'not_started' ||
      task.status === 'in_progress'
    ) {
      nextActions.push(`Task ${task.id} (${task.title}) is ${task.status}`);
    }
  }

  return {
    blockers: dedupeList(blockers),
    nextActions: dedupeList(nextActions),
  };
}

function collectQuestionsFromProgress(progressText: string): string[] {
  const out: string[] = [];
  const lines = progressText.split('\n').slice(-200);
  for (const line of lines) {
    const trimmed = normalizeText(line);
    if (!trimmed) continue;
    if (trimmed.endsWith('?')) out.push(trimmed);
  }
  return dedupeList(out);
}

function collectEvidenceFromSdkOutput(sdkRaw: string): string[] {
  const parsed = readJsonRecord(sdkRaw);
  if (!parsed) return [];
  const toolCalls = Array.isArray(parsed.tool_calls)
    ? parsed.tool_calls.filter((entry): entry is JsonRecord => isPlainRecord(entry))
    : [];
  const out = new Set<string>();

  for (const call of toolCalls) {
    const retrieval = isPlainRecord(call.response_retrieval) ? call.response_retrieval : null;
    if (!retrieval) continue;
    if (Array.isArray(retrieval.artifact_paths)) {
      for (const rawPath of retrieval.artifact_paths) {
        const normalized = normalizeText(rawPath);
        if (!normalized) continue;
        out.add(normalized.replace(/\\/g, '/'));
      }
    }
    if (typeof retrieval.handle === 'string') {
      const normalizedHandle = normalizeText(retrieval.handle);
      if (normalizedHandle) out.add(normalizedHandle);
    }
  }

  return dedupeList([...out]);
}

function buildSnapshotItems(snapshot: ActiveContextSnapshot): string[] {
  return [
    snapshot.current_objective,
    ...snapshot.open_hypotheses,
    ...snapshot.blockers,
    ...snapshot.next_actions,
    ...snapshot.unresolved_questions,
    ...snapshot.required_evidence_links,
  ];
}

function estimateTokenSize(snapshot: ActiveContextSnapshot): number {
  const raw = JSON.stringify(snapshot);
  if (!raw) return 0;
  return Math.max(1, Math.ceil(raw.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN));
}

function createRetiredRecords(params: {
  previous: ActiveContextSnapshot | null;
  current: ActiveContextSnapshot;
  nowIso: string;
}): RetiredTrajectoryRecord[] {
  const previous = params.previous;
  if (!previous) return [];

  const retired: RetiredTrajectoryRecord[] = [];
  const createCategoryRetirements = (
    field: Exclude<SnapshotField, 'current_objective'>,
    previousValues: readonly string[],
    currentValues: readonly string[],
  ): void => {
    const currentSet = new Set(currentValues.map((value) => toComparableKey(value)));
    for (const previousValue of previousValues) {
      const key = toComparableKey(previousValue);
      if (currentSet.has(key)) continue;
      retired.push({
        schema_version: 1,
        retired_at: params.nowIso,
        iteration: params.current.iteration,
        previous_iteration: previous.iteration,
        field,
        value: previousValue,
        reason: 'no_longer_active',
      });
    }
  };

  if (toComparableKey(previous.current_objective) !== toComparableKey(params.current.current_objective)) {
    retired.push({
      schema_version: 1,
      retired_at: params.nowIso,
      iteration: params.current.iteration,
      previous_iteration: previous.iteration,
      field: 'current_objective',
      value: previous.current_objective,
      reason: 'no_longer_active',
    });
  }

  createCategoryRetirements('open_hypotheses', previous.open_hypotheses, params.current.open_hypotheses);
  createCategoryRetirements('blockers', previous.blockers, params.current.blockers);
  createCategoryRetirements('next_actions', previous.next_actions, params.current.next_actions);
  createCategoryRetirements('unresolved_questions', previous.unresolved_questions, params.current.unresolved_questions);
  createCategoryRetirements(
    'required_evidence_links',
    previous.required_evidence_links,
    params.current.required_evidence_links,
  );

  return retired;
}

function createDiagnostics(params: {
  snapshot: ActiveContextSnapshot;
  previous: ActiveContextSnapshot | null;
  retired: readonly RetiredTrajectoryRecord[];
  nowIso: string;
}): TrajectoryReductionDiagnostics {
  const currentItems = dedupeList(buildSnapshotItems(params.snapshot), { maxItems: null });
  const previousItems = params.previous
    ? dedupeList(buildSnapshotItems(params.previous), { maxItems: null })
    : [];
  const previousSet = new Set(previousItems.map((value) => toComparableKey(value)));

  let repeatedItemCount = 0;
  for (const item of currentItems) {
    if (previousSet.has(toComparableKey(item))) repeatedItemCount += 1;
  }
  const repeatedContextRate = currentItems.length > 0
    ? repeatedItemCount / currentItems.length
    : 0;

  const activeSnapshotTokenSize = estimateTokenSize(params.snapshot);
  const warnings: string[] = [];
  if (repeatedContextRate > 0.85 && params.snapshot.iteration > 1) {
    warnings.push(
      `High repeated-context rate (${(repeatedContextRate * 100).toFixed(1)}%). Consider retiring stale hypotheses/questions more aggressively.`,
    );
  }
  if (activeSnapshotTokenSize > 1400) {
    warnings.push(
      `Active snapshot token size is high (${activeSnapshotTokenSize}). Consider tightening next-actions/evidence lists.`,
    );
  }

  return {
    schema_version: 1,
    generated_at: params.nowIso,
    iteration: params.snapshot.iteration,
    active_snapshot_token_size: activeSnapshotTokenSize,
    retired_branch_count: params.retired.length,
    repeated_context_rate: repeatedContextRate,
    active_item_count: currentItems.length,
    repeated_item_count: repeatedItemCount,
    warnings,
  };
}

async function appendRetiredRecords(
  stateDir: string,
  records: readonly RetiredTrajectoryRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const filePath = path.join(stateDir, RETIRED_TRAJECTORY_FILE);
  const payload = records.map((record) => JSON.stringify(record)).join('\n');
  await fs.appendFile(filePath, `${payload}\n`, 'utf-8');
}

export async function computeTrajectoryReduction(params: {
  stateDir: string;
  iteration: number;
  nowIso?: () => string;
}): Promise<TrajectoryReductionResult> {
  const now = params.nowIso ? params.nowIso() : new Date().toISOString();
  const issue = await readJsonRecordFromFile(path.join(params.stateDir, 'issue.json'));
  const tasks = await readJsonRecordFromFile(path.join(params.stateDir, 'tasks.json'));
  const progressText = renderProgressText({ stateDir: params.stateDir });
  const sdkRaw = await fs.readFile(path.join(params.stateDir, 'sdk-output.json'), 'utf-8').catch(() => '');

  let memoryEntries: MemoryEntry[] = [];
  try {
    memoryEntries = listMemoryEntriesFromDb({
      stateDir: params.stateDir,
      includeStale: false,
      limit: null,
    });
  } catch {
    memoryEntries = [];
  }

  const previous = await readPreviousSnapshot(params.stateDir);
  const memoryContext = collectCategoryFromMemory(memoryEntries);
  const taskContext = collectTaskDerivedContext(tasks);
  const progressQuestions = collectQuestionsFromProgress(progressText);
  const sdkEvidence = collectEvidenceFromSdkOutput(sdkRaw);

  const snapshot: ActiveContextSnapshot = {
    schema_version: 1,
    generated_at: now,
    iteration: params.iteration,
    current_objective: objectiveFromIssue(issue),
    open_hypotheses: dedupeList(memoryContext.openHypotheses),
    blockers: dedupeList([...memoryContext.blockers, ...taskContext.blockers]),
    next_actions: dedupeList([...memoryContext.nextActions, ...taskContext.nextActions]),
    unresolved_questions: dedupeList([...memoryContext.unresolvedQuestions, ...progressQuestions]),
    required_evidence_links: dedupeList([...memoryContext.evidenceLinks, ...sdkEvidence]),
  };

  const retired = createRetiredRecords({
    previous,
    current: snapshot,
    nowIso: now,
  });
  const diagnostics = createDiagnostics({
    snapshot,
    previous,
    retired,
    nowIso: now,
  });

  await writeJsonAtomic(path.join(params.stateDir, ACTIVE_CONTEXT_FILE), snapshot);
  await appendRetiredRecords(params.stateDir, retired);
  await writeJsonAtomic(path.join(params.stateDir, TRAJECTORY_REDUCTION_FILE), diagnostics);

  return { snapshot, retired, diagnostics };
}

export function mergeTrajectoryReductionSummary(
  current: TrajectoryReductionSummary | null,
  diagnostics: TrajectoryReductionDiagnostics,
): TrajectoryReductionSummary {
  const previousIterations = current?.iterations_with_reduction ?? 0;
  const nextIterations = previousIterations + 1;
  const previousAverage = current?.avg_repeated_context_rate ?? 0;
  const avgRepeatedContextRate = ((previousAverage * previousIterations) + diagnostics.repeated_context_rate) / nextIterations;

  return {
    schema_version: 1,
    iterations_with_reduction: nextIterations,
    total_retired_branch_count:
      (current?.total_retired_branch_count ?? 0) + diagnostics.retired_branch_count,
    max_active_snapshot_token_size: Math.max(
      current?.max_active_snapshot_token_size ?? 0,
      diagnostics.active_snapshot_token_size,
    ),
    avg_repeated_context_rate: avgRepeatedContextRate,
    max_repeated_context_rate: Math.max(
      current?.max_repeated_context_rate ?? 0,
      diagnostics.repeated_context_rate,
    ),
  };
}
