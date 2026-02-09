import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

type JsonRecord = Record<string, unknown>;
type JsonValue = unknown;

type DbHandle = Database.Database;

export type StoredIssueSummary = Readonly<{
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  branch: string;
  phase: string;
  stateDir: string;
  updatedAt: string;
}>;

export type StoredPrompt = Readonly<{ id: string; content: string; updatedAt: string }>;
export type StoredWorkflow = Readonly<{ name: string; yaml: string; updatedAt: string }>;

export type ProgressEvent = Readonly<{
  id: number;
  stateDir: string;
  ts: string;
  source: string;
  phase: string | null;
  level: string | null;
  message: string;
  payload: JsonRecord | null;
}>;

export type RunSession = Readonly<{
  runId: string;
  stateDir: string;
  issueRef: string | null;
  startedAt: string;
  endedAt: string | null;
  status: JsonRecord;
  archiveMeta: JsonRecord;
}>;

export type RunLogLine = Readonly<{
  id: number;
  runId: string;
  scope: string;
  taskId: string;
  stream: string;
  ts: string;
  line: string;
}>;

export type RunSdkEvent = Readonly<{
  id: number;
  runId: string;
  scope: string;
  taskId: string;
  ts: string;
  event: JsonRecord;
}>;

export type RunArtifact = Readonly<{
  runId: string;
  scope: string;
  taskId: string;
  name: string;
  mime: string;
  content: Buffer;
  createdAt: string;
}>;

export type WorkerState = Readonly<{
  runId: string;
  taskId: string;
  stateDir: string;
  branch: string;
  worktreeDir: string;
  status: JsonRecord;
}>;

export type DbHealthSummary = Readonly<{
  dbPath: string;
  exists: boolean;
  sizeBytes: number;
  walBytes: number;
  shmBytes: number;
  journalMode: string;
  foreignKeys: boolean;
  synchronous: string;
}>;

export type DbIntegrityResult = Readonly<{
  ok: boolean;
  rows: readonly string[];
}>;

export type DbVacuumResult = Readonly<{
  beforeBytes: number;
  afterBytes: number;
}>;

export type DbBackupResult = Readonly<{
  path: string;
  sizeBytes: number;
}>;

function nowIso(): string {
  return new Date().toISOString();
}

export function dbPathForDataDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'jeeves.db');
}

export function deriveDataDirFromStateDir(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  const marker = `${path.sep}issues${path.sep}`;
  const idx = resolved.lastIndexOf(marker);
  if (idx !== -1) return resolved.slice(0, idx);
  return path.resolve(path.dirname(resolved));
}

function withDb<T>(dataDir: string, fn: (db: DbHandle) => T): T {
  const dbPath = dbPathForDataDir(dataDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    ensureSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

async function withDbAsync<T>(dataDir: string, fn: (db: DbHandle) => Promise<T>): Promise<T> {
  const dbPath = dbPathForDataDir(dataDir);
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    ensureSchema(db);
    return await fn(db);
  } finally {
    db.close();
  }
}

function tryParseJson(raw: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function parseJsonRecord(raw: string): JsonRecord | null {
  const parsed = tryParseJson(raw);
  if (!parsed.ok) return null;
  const value = parsed.value;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function toTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function statSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function ensureSchema(db: DbHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      UNIQUE(owner, repo)
    );

    CREATE TABLE IF NOT EXISTS repository_issues (
      id INTEGER PRIMARY KEY,
      repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      issue_number INTEGER NOT NULL CHECK (issue_number > 0),
      issue_title TEXT NOT NULL DEFAULT '',
      UNIQUE(repository_id, issue_number)
    );

    CREATE INDEX IF NOT EXISTS idx_repository_issues_lookup
      ON repository_issues(repository_id, issue_number);

    CREATE TABLE IF NOT EXISTS issue_state_core (
      state_dir TEXT PRIMARY KEY,
      issue_id INTEGER REFERENCES repository_issues(id) ON DELETE SET NULL,
      branch TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL DEFAULT '',
      workflow TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_issue_state_core_issue_id
      ON issue_state_core(issue_id);

    CREATE TABLE IF NOT EXISTS issue_state_payload (
      state_dir TEXT PRIMARY KEY REFERENCES issue_state_core(state_dir) ON DELETE CASCADE,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issue_task_lists (
      state_dir TEXT PRIMARY KEY,
      metadata_json TEXT NOT NULL,
      tasks_split INTEGER NOT NULL CHECK (tasks_split IN (0, 1)),
      task_count INTEGER NOT NULL CHECK (task_count >= 0),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issue_task_items (
      state_dir TEXT NOT NULL REFERENCES issue_task_lists(state_dir) ON DELETE CASCADE,
      task_index INTEGER NOT NULL CHECK (task_index >= 0),
      task_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      PRIMARY KEY(state_dir, task_index)
    );

    CREATE INDEX IF NOT EXISTS idx_issue_task_items_state_idx
      ON issue_task_items(state_dir, task_index);

    CREATE TABLE IF NOT EXISTS issue_task_dependencies (
      state_dir TEXT NOT NULL,
      task_index INTEGER NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY(state_dir, task_index, depends_on_task_id),
      FOREIGN KEY(state_dir, task_index) REFERENCES issue_task_items(state_dir, task_index) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_issue_task_dependencies_state_task
      ON issue_task_dependencies(state_dir, task_index);

    CREATE TABLE IF NOT EXISTS active_issue (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      issue_ref TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      name TEXT PRIMARY KEY,
      yaml TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS progress_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state_dir TEXT NOT NULL,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      phase TEXT,
      level TEXT,
      message TEXT NOT NULL,
      payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_progress_events_state_id
      ON progress_events(state_dir, id);

    CREATE TABLE IF NOT EXISTS run_sessions (
      run_id TEXT PRIMARY KEY,
      state_dir TEXT NOT NULL,
      issue_ref TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status_json TEXT NOT NULL,
      archive_meta_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_sessions_state_started
      ON run_sessions(state_dir, started_at DESC);

    CREATE TABLE IF NOT EXISTS run_iterations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES run_sessions(run_id) ON DELETE CASCADE,
      iteration INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      UNIQUE(run_id, iteration)
    );

    CREATE TABLE IF NOT EXISTS run_log_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES run_sessions(run_id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      stream TEXT NOT NULL,
      ts TEXT NOT NULL,
      line TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_log_lines_lookup
      ON run_log_lines(run_id, scope, task_id, stream, id);

    CREATE TABLE IF NOT EXISTS run_sdk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES run_sessions(run_id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      ts TEXT NOT NULL,
      event_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_sdk_events_lookup
      ON run_sdk_events(run_id, scope, task_id, id);

    CREATE TABLE IF NOT EXISTS run_artifacts (
      run_id TEXT NOT NULL REFERENCES run_sessions(run_id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      content BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, scope, task_id, name)
    );

    CREATE TABLE IF NOT EXISTS worker_states (
      run_id TEXT NOT NULL REFERENCES run_sessions(run_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      state_dir TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_dir TEXT NOT NULL,
      status_json TEXT NOT NULL,
      PRIMARY KEY(run_id, task_id)
    );

    CREATE INDEX IF NOT EXISTS idx_worker_states_state
      ON worker_states(state_dir, run_id, task_id);
  `);
}

function parseRepoSpecFromIssueJson(json: JsonRecord): { owner: string; repo: string } | null {
  const direct = typeof json.repo === 'string' ? json.repo.trim() : '';
  if (direct.includes('/')) {
    const [owner, repo] = direct.split('/');
    if (owner && repo) return { owner, repo };
  }

  const issue = json.issue;
  if (issue && typeof issue === 'object' && !Array.isArray(issue)) {
    const issueRepoRaw = (issue as JsonRecord).repo;
    const issueRepo = typeof issueRepoRaw === 'string' ? issueRepoRaw.trim() : '';
    if (issueRepo.includes('/')) {
      const [owner, repo] = issueRepo.split('/');
      if (owner && repo) return { owner, repo };
    }
  }

  return null;
}

function parseIssueNumber(json: JsonRecord): number | null {
  const issue = json.issue;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return null;
  const n = (issue as JsonRecord).number;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

function parseIssueTitle(json: JsonRecord): string {
  const issue = json.issue;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return '';
  const title = (issue as JsonRecord).title;
  return typeof title === 'string' ? title : '';
}

function parseStateDirFallback(stateDir: string): { owner: string; repo: string; issueNumber: number } | null {
  const resolved = path.resolve(stateDir);
  const marker = `${path.sep}issues${path.sep}`;
  const idx = resolved.lastIndexOf(marker);
  if (idx === -1) return null;
  const rel = resolved.slice(idx + marker.length);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length < 3) return null;
  const owner = parts[0] ?? '';
  const repo = parts[1] ?? '';
  const issueRaw = parts[2] ?? '';
  const issueNumber = Number(issueRaw);
  if (!owner || !repo || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  return { owner, repo, issueNumber };
}

function extractIssueSummary(data: JsonRecord, stateDir: string): {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  branch: string;
  phase: string;
  workflow: string;
} {
  const repoSpec = parseRepoSpecFromIssueJson(data);
  const fallback = parseStateDirFallback(stateDir);

  const owner = repoSpec?.owner ?? fallback?.owner ?? 'unknown';
  const repo = repoSpec?.repo ?? fallback?.repo ?? 'unknown';
  const issueNumber = parseIssueNumber(data) ?? fallback?.issueNumber ?? 0;
  const issueTitle = parseIssueTitle(data);
  const branch = typeof data.branch === 'string' ? data.branch : '';
  const phase = typeof data.phase === 'string' ? data.phase : '';
  const workflow = typeof data.workflow === 'string' ? data.workflow : '';

  return { owner, repo, issueNumber, issueTitle, branch, phase, workflow };
}

function upsertRepository(db: DbHandle, owner: string, repo: string): number {
  db.prepare(
    `
    INSERT INTO repositories (owner, repo)
    VALUES (?, ?)
    ON CONFLICT(owner, repo) DO NOTHING
    `,
  ).run(owner, repo);

  const row = db
    .prepare('SELECT id FROM repositories WHERE owner = ? AND repo = ?')
    .get(owner, repo) as { id: number } | undefined;
  if (!row) {
    throw new Error(`Failed to resolve repository id for ${owner}/${repo}`);
  }
  return row.id;
}

function upsertRepositoryIssue(db: DbHandle, repositoryId: number, issueNumber: number, issueTitle: string): number {
  db.prepare(
    `
    INSERT INTO repository_issues (repository_id, issue_number, issue_title)
    VALUES (?, ?, ?)
    ON CONFLICT(repository_id, issue_number) DO UPDATE SET
      issue_title = excluded.issue_title
    `,
  ).run(repositoryId, issueNumber, issueTitle);

  const row = db
    .prepare('SELECT id FROM repository_issues WHERE repository_id = ? AND issue_number = ?')
    .get(repositoryId, issueNumber) as { id: number } | undefined;
  if (!row) {
    throw new Error(`Failed to resolve issue id for repository=${repositoryId} issue=${issueNumber}`);
  }
  return row.id;
}

function upsertIssueStateNormalized(
  db: DbHandle,
  stateDir: string,
  data: JsonRecord,
  updatedAt: string,
): void {
  const normalizedStateDir = path.resolve(stateDir);
  const summary = extractIssueSummary(data, normalizedStateDir);

  let issueId: number | null = null;
  if (summary.issueNumber > 0) {
    const repositoryId = upsertRepository(db, summary.owner, summary.repo);
    issueId = upsertRepositoryIssue(db, repositoryId, summary.issueNumber, summary.issueTitle);
  }

  db.prepare(
    `
    INSERT INTO issue_state_core (state_dir, issue_id, branch, phase, workflow, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(state_dir) DO UPDATE SET
      issue_id = excluded.issue_id,
      branch = excluded.branch,
      phase = excluded.phase,
      workflow = excluded.workflow,
      updated_at = excluded.updated_at
    `,
  ).run(normalizedStateDir, issueId, summary.branch, summary.phase, summary.workflow, updatedAt);

  db.prepare(
    `
    INSERT INTO issue_state_payload (state_dir, payload_json)
    VALUES (?, ?)
    ON CONFLICT(state_dir) DO UPDATE SET
      payload_json = excluded.payload_json
    `,
  ).run(normalizedStateDir, JSON.stringify(data));
}

export function readIssueFromDb(stateDir: string): JsonRecord | null {
  const dataDir = deriveDataDirFromStateDir(stateDir);
  const normalizedStateDir = path.resolve(stateDir);
  return withDb(dataDir, (db) => {
    const row = db
      .prepare('SELECT payload_json FROM issue_state_payload WHERE state_dir = ?')
      .get(normalizedStateDir) as { payload_json: string } | undefined;
    const payload = row?.payload_json;
    if (!payload) return null;
    return parseJsonRecord(payload);
  });
}

export function writeIssueToDb(stateDir: string, data: JsonRecord): void {
  const dataDir = deriveDataDirFromStateDir(stateDir);
  const updatedAt = nowIso();

  withDb(dataDir, (db) => {
    upsertIssueStateNormalized(db, stateDir, data, updatedAt);
  });
}

export function listIssuesFromDb(dataDir: string): StoredIssueSummary[] {
  return withDb(dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT r.owner AS owner,
               r.repo AS repo,
               i.issue_number AS issue_number,
               i.issue_title AS issue_title,
               s.branch AS branch,
               s.phase AS phase,
               s.state_dir AS state_dir,
               s.updated_at AS updated_at
        FROM issue_state_core s
        LEFT JOIN repository_issues i ON i.id = s.issue_id
        LEFT JOIN repositories r ON r.id = i.repository_id
        ORDER BY COALESCE(r.owner, 'unknown') ASC,
                 COALESCE(r.repo, 'unknown') ASC,
                 COALESCE(i.issue_number, 0) ASC
        `,
      )
      .all() as {
      owner: string | null;
      repo: string | null;
      issue_number: number | null;
      issue_title: string | null;
      branch: string | null;
      phase: string | null;
      state_dir: string;
      updated_at: string;
    }[];

    const normalized = rows
      .filter((row) => Number.isInteger(row.issue_number) && (row.issue_number ?? 0) > 0)
      .map((row) => ({
        owner: row.owner ?? 'unknown',
        repo: row.repo ?? 'unknown',
        issueNumber: row.issue_number ?? 0,
        issueTitle: row.issue_title ?? '',
        branch: row.branch ?? '',
        phase: row.phase ?? '',
        stateDir: row.state_dir,
        updatedAt: row.updated_at,
      }));
    return normalized;
  });
}

export function readIssueUpdatedAtMs(stateDir: string): number {
  const dataDir = deriveDataDirFromStateDir(stateDir);
  const normalizedStateDir = path.resolve(stateDir);
  return withDb(dataDir, (db) => {
    const row = db
      .prepare('SELECT updated_at FROM issue_state_core WHERE state_dir = ?')
      .get(normalizedStateDir) as { updated_at: string } | undefined;
    const updatedAt = row?.updated_at;
    const ms = toTimestampMs(updatedAt);
    return Number.isFinite(ms) ? ms : 0;
  });
}

type SplitTaskDocument = Readonly<{
  tasksSplit: 0 | 1;
  metadata: JsonRecord;
  tasks: JsonValue[];
}>;

function splitTaskDocument(data: JsonRecord): SplitTaskDocument {
  const tasksRaw = data.tasks;
  if (!Array.isArray(tasksRaw)) {
    const metadata: JsonRecord = {};
    for (const [key, value] of Object.entries(data)) {
      metadata[key] = value;
    }
    return { tasksSplit: 0, metadata, tasks: [] };
  }

  const metadata: JsonRecord = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'tasks') continue;
    metadata[key] = value;
  }

  return { tasksSplit: 1, metadata, tasks: tasksRaw as JsonValue[] };
}

function extractTaskFields(task: JsonValue): {
  id: string;
  title: string;
  summary: string;
  status: string;
  dependsOn: string[];
} {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return { id: '', title: '', summary: '', status: '', dependsOn: [] };
  }

  const record = task as JsonRecord;
  const dependsOnRaw = record.dependsOn;
  const dependsOn = Array.isArray(dependsOnRaw)
    ? Array.from(
      new Set(
        dependsOnRaw
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim()),
      ),
    )
    : [];

  return {
    id: typeof record.id === 'string' ? record.id : '',
    title: typeof record.title === 'string' ? record.title : '',
    summary: typeof record.summary === 'string' ? record.summary : '',
    status: typeof record.status === 'string' ? record.status : '',
    dependsOn,
  };
}

function upsertTaskDocumentNormalized(
  db: DbHandle,
  stateDir: string,
  data: JsonRecord,
  updatedAt: string,
): void {
  const normalizedStateDir = path.resolve(stateDir);
  const split = splitTaskDocument(data);

  db.prepare('DELETE FROM issue_task_lists WHERE state_dir = ?').run(normalizedStateDir);
  db.prepare(
    `
    INSERT INTO issue_task_lists (state_dir, metadata_json, tasks_split, task_count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    normalizedStateDir,
    JSON.stringify(split.metadata),
    split.tasksSplit,
    split.tasks.length,
    updatedAt,
  );

  const insertItem = db.prepare(
    `
    INSERT INTO issue_task_items (
      state_dir,
      task_index,
      task_id,
      title,
      summary,
      status,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertDependency = db.prepare(
    `
    INSERT OR IGNORE INTO issue_task_dependencies (state_dir, task_index, depends_on_task_id)
    VALUES (?, ?, ?)
    `,
  );

  split.tasks.forEach((task, index) => {
    const fields = extractTaskFields(task);
    insertItem.run(
      normalizedStateDir,
      index,
      fields.id,
      fields.title,
      fields.summary,
      fields.status,
      JSON.stringify(task),
    );
    for (const dependsOnTaskId of fields.dependsOn) {
      insertDependency.run(normalizedStateDir, index, dependsOnTaskId);
    }
  });
}

function readTasksFromNormalizedTables(db: DbHandle, normalizedStateDir: string): JsonRecord | null {
  const row = db
    .prepare(
      `
      SELECT metadata_json, tasks_split
      FROM issue_task_lists
      WHERE state_dir = ?
      `,
    )
    .get(normalizedStateDir) as { metadata_json: string; tasks_split: number } | undefined;

  if (!row) return null;
  const metadata = parseJsonRecord(row.metadata_json);
  if (!metadata) return null;

  if (row.tasks_split === 0) {
    return metadata;
  }

  const itemRows = db
    .prepare(
      `
      SELECT payload_json
      FROM issue_task_items
      WHERE state_dir = ?
      ORDER BY task_index ASC
      `,
    )
    .all(normalizedStateDir) as { payload_json: string }[];

  const tasks: JsonValue[] = [];
  for (const item of itemRows) {
    const parsed = tryParseJson(item.payload_json);
    if (!parsed.ok) return null;
    tasks.push(parsed.value);
  }

  return { ...metadata, tasks };
}

export function readTasksFromDb(stateDir: string): JsonRecord | null {
  const dataDir = deriveDataDirFromStateDir(stateDir);
  const normalizedStateDir = path.resolve(stateDir);
  return withDb(dataDir, (db) => readTasksFromNormalizedTables(db, normalizedStateDir));
}

export function writeTasksToDb(stateDir: string, data: JsonRecord): void {
  const dataDir = deriveDataDirFromStateDir(stateDir);
  const updatedAt = nowIso();

  withDb(dataDir, (db) => {
    const tx = db.transaction(() => {
      upsertTaskDocumentNormalized(db, stateDir, data, updatedAt);
    });
    tx();
  });
}

export function readTaskCountFromDb(stateDir: string): number | null {
  const dataDir = deriveDataDirFromStateDir(stateDir);
  const normalizedStateDir = path.resolve(stateDir);
  return withDb(dataDir, (db) => {
    const row = db
      .prepare(
        `
        SELECT task_count
        FROM issue_task_lists
        WHERE state_dir = ?
        `,
      )
      .get(normalizedStateDir) as { task_count: number } | undefined;
    if (row && Number.isInteger(row.task_count) && row.task_count >= 0) {
      return row.task_count;
    }
    return null;
  });
}

export function saveActiveIssueToDb(dataDir: string, issueRef: string, savedAt: string): void {
  withDb(dataDir, (db) => {
    db.prepare(
      `
      INSERT INTO active_issue (slot, issue_ref, saved_at)
      VALUES (1, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET
        issue_ref = excluded.issue_ref,
        saved_at = excluded.saved_at
      `,
    ).run(issueRef, savedAt);
  });
}

export function loadActiveIssueFromDb(dataDir: string): string | null {
  return withDb(dataDir, (db) => {
    const row = db.prepare('SELECT issue_ref FROM active_issue WHERE slot = 1').get() as { issue_ref: string } | undefined;
    if (!row || typeof row.issue_ref !== 'string') return null;
    const trimmed = row.issue_ref.trim();
    return trimmed ? trimmed : null;
  });
}

export function clearActiveIssueFromDb(dataDir: string): void {
  withDb(dataDir, (db) => {
    db.prepare('DELETE FROM active_issue WHERE slot = 1').run();
  });
}

export function listPromptsFromDb(dataDir: string): StoredPrompt[] {
  return withDb(dataDir, (db) => {
    const rows = db
      .prepare('SELECT id, content, updated_at FROM prompts ORDER BY id ASC')
      .all() as { id: string; content: string; updated_at: string }[];
    return rows.map((row) => ({ id: row.id, content: row.content, updatedAt: row.updated_at }));
  });
}

export function readPromptFromDb(dataDir: string, id: string): StoredPrompt | null {
  return withDb(dataDir, (db) => {
    const row = db
      .prepare('SELECT id, content, updated_at FROM prompts WHERE id = ?')
      .get(id) as { id: string; content: string; updated_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, content: row.content, updatedAt: row.updated_at };
  });
}

export function upsertPromptInDb(dataDir: string, id: string, content: string): void {
  const updatedAt = nowIso();
  withDb(dataDir, (db) => {
    db.prepare(
      `
      INSERT INTO prompts (id, content, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
      `,
    ).run(id, content, updatedAt);
  });
}

export function countPromptsInDb(dataDir: string): number {
  return withDb(dataDir, (db) => {
    const row = db.prepare('SELECT COUNT(*) as count FROM prompts').get() as { count: number };
    return row.count;
  });
}

export function listWorkflowsFromDb(dataDir: string): StoredWorkflow[] {
  return withDb(dataDir, (db) => {
    const rows = db
      .prepare('SELECT name, yaml, updated_at FROM workflows ORDER BY name ASC')
      .all() as { name: string; yaml: string; updated_at: string }[];
    return rows.map((row) => ({ name: row.name, yaml: row.yaml, updatedAt: row.updated_at }));
  });
}

export function readWorkflowFromDb(dataDir: string, name: string): StoredWorkflow | null {
  return withDb(dataDir, (db) => {
    const row = db
      .prepare('SELECT name, yaml, updated_at FROM workflows WHERE name = ?')
      .get(name) as { name: string; yaml: string; updated_at: string } | undefined;
    if (!row) return null;
    return { name: row.name, yaml: row.yaml, updatedAt: row.updated_at };
  });
}

export function upsertWorkflowInDb(dataDir: string, name: string, yaml: string): void {
  const updatedAt = nowIso();
  withDb(dataDir, (db) => {
    db.prepare(
      `
      INSERT INTO workflows (name, yaml, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        yaml = excluded.yaml,
        updated_at = excluded.updated_at
      `,
    ).run(name, yaml, updatedAt);
  });
}

export function countWorkflowsInDb(dataDir: string): number {
  return withDb(dataDir, (db) => {
    const row = db.prepare('SELECT COUNT(*) as count FROM workflows').get() as { count: number };
    return row.count;
  });
}

export function getMetaValue(dataDir: string, key: string): string | null {
  return withDb(dataDir, (db) => {
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  });
}

export function setMetaValue(dataDir: string, key: string, value: string): void {
  const updatedAt = nowIso();
  withDb(dataDir, (db) => {
    db.prepare(
      `
      INSERT INTO meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      `,
    ).run(key, value, updatedAt);
  });
}

export function isBootstrapComplete(dataDir: string): boolean {
  const marker = getMetaValue(dataDir, 'bootstrap_version');
  return Boolean(marker && marker.trim().length > 0);
}

export function markBootstrapComplete(dataDir: string, version: string): void {
  const normalized = version.trim() || '1';
  setMetaValue(dataDir, 'bootstrap_version', normalized);
  setMetaValue(dataDir, 'bootstrap_completed_at', nowIso());
}

export function appendProgressEvent(params: {
  stateDir: string;
  source: string;
  message: string;
  phase?: string | null;
  level?: string | null;
  payload?: JsonRecord | null;
  ts?: string;
}): number {
  const dataDir = deriveDataDirFromStateDir(params.stateDir);
  const normalizedStateDir = path.resolve(params.stateDir);
  const ts = params.ts ?? nowIso();
  return withDb(dataDir, (db) => {
    const result = db.prepare(
      `
      INSERT INTO progress_events (state_dir, ts, source, phase, level, message, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      normalizedStateDir,
      ts,
      params.source,
      params.phase ?? null,
      params.level ?? null,
      params.message,
      params.payload ? JSON.stringify(params.payload) : null,
    );
    return Number(result.lastInsertRowid);
  });
}

export function listProgressEvents(params: {
  stateDir: string;
  afterId?: number;
  limit?: number;
}): ProgressEvent[] {
  const dataDir = deriveDataDirFromStateDir(params.stateDir);
  const normalizedStateDir = path.resolve(params.stateDir);
  const afterId = Number.isInteger(params.afterId) ? Number(params.afterId) : 0;
  const limit = Number.isInteger(params.limit) ? Math.max(1, Number(params.limit)) : 500;
  return withDb(dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT id, state_dir, ts, source, phase, level, message, payload_json
        FROM progress_events
        WHERE state_dir = ?
          AND id > ?
        ORDER BY id ASC
        LIMIT ?
        `,
      )
      .all(normalizedStateDir, afterId, limit) as {
      id: number;
      state_dir: string;
      ts: string;
      source: string;
      phase: string | null;
      level: string | null;
      message: string;
      payload_json: string | null;
    }[];

    return rows.map((row) => ({
      id: row.id,
      stateDir: row.state_dir,
      ts: row.ts,
      source: row.source,
      phase: row.phase,
      level: row.level,
      message: row.message,
      payload: row.payload_json ? parseJsonRecord(row.payload_json) : null,
    }));
  });
}

export function renderProgressText(params: {
  stateDir: string;
  maxEvents?: number;
}): string {
  const rows = listProgressEvents({
    stateDir: params.stateDir,
    afterId: 0,
    limit: Number.isInteger(params.maxEvents) ? Math.max(1, Number(params.maxEvents)) : 5000,
  });
  return rows
    .map((row) => {
      const parts: string[] = [row.ts, row.source];
      if (row.phase) parts.push(`phase=${row.phase}`);
      if (row.level) parts.push(`level=${row.level}`);
      return `[${parts.join(' ')}] ${row.message}`;
    })
    .join('\n');
}

export function upsertRunSession(params: {
  dataDir: string;
  runId: string;
  stateDir: string;
  issueRef?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  status?: JsonRecord;
  archiveMeta?: JsonRecord;
}): void {
  const startedAt = params.startedAt ?? nowIso();
  withDb(params.dataDir, (db) => {
    const existing = db
      .prepare(
        `
        SELECT started_at, status_json, archive_meta_json
        FROM run_sessions
        WHERE run_id = ?
        `,
      )
      .get(params.runId) as {
      started_at: string;
      status_json: string;
      archive_meta_json: string;
    } | undefined;

    const nextStatus = params.status ?? (existing?.status_json ? (parseJsonRecord(existing.status_json) ?? {}) : {});
    const nextArchive = params.archiveMeta ?? (existing?.archive_meta_json ? (parseJsonRecord(existing.archive_meta_json) ?? {}) : {});
    db.prepare(
      `
      INSERT INTO run_sessions (run_id, state_dir, issue_ref, started_at, ended_at, status_json, archive_meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        state_dir = excluded.state_dir,
        issue_ref = excluded.issue_ref,
        ended_at = excluded.ended_at,
        status_json = excluded.status_json,
        archive_meta_json = excluded.archive_meta_json
      `,
    ).run(
      params.runId,
      path.resolve(params.stateDir),
      params.issueRef ?? null,
      existing?.started_at ?? startedAt,
      params.endedAt ?? null,
      JSON.stringify(nextStatus),
      JSON.stringify(nextArchive),
    );
  });
}

export function readRunSession(dataDir: string, runId: string): RunSession | null {
  return withDb(dataDir, (db) => {
    const row = db
      .prepare(
        `
        SELECT run_id, state_dir, issue_ref, started_at, ended_at, status_json, archive_meta_json
        FROM run_sessions
        WHERE run_id = ?
        `,
      )
      .get(runId) as {
      run_id: string;
      state_dir: string;
      issue_ref: string | null;
      started_at: string;
      ended_at: string | null;
      status_json: string;
      archive_meta_json: string;
    } | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      stateDir: row.state_dir,
      issueRef: row.issue_ref,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: parseJsonRecord(row.status_json) ?? {},
      archiveMeta: parseJsonRecord(row.archive_meta_json) ?? {},
    };
  });
}

export function listRunSessionsForStateDir(params: {
  dataDir: string;
  stateDir: string;
  limit?: number;
}): RunSession[] {
  const limit = Number.isInteger(params.limit) ? Math.max(1, Number(params.limit)) : 100;
  return withDb(params.dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT run_id, state_dir, issue_ref, started_at, ended_at, status_json, archive_meta_json
        FROM run_sessions
        WHERE state_dir = ?
        ORDER BY started_at DESC
        LIMIT ?
        `,
      )
      .all(path.resolve(params.stateDir), limit) as {
      run_id: string;
      state_dir: string;
      issue_ref: string | null;
      started_at: string;
      ended_at: string | null;
      status_json: string;
      archive_meta_json: string;
    }[];
    return rows.map((row) => ({
      runId: row.run_id,
      stateDir: row.state_dir,
      issueRef: row.issue_ref,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: parseJsonRecord(row.status_json) ?? {},
      archiveMeta: parseJsonRecord(row.archive_meta_json) ?? {},
    }));
  });
}

export function getLatestRunIdForStateDir(dataDir: string, stateDir: string): string | null {
  return withDb(dataDir, (db) => {
    const row = db
      .prepare(
        `
        SELECT run_id
        FROM run_sessions
        WHERE state_dir = ?
        ORDER BY started_at DESC
        LIMIT 1
        `,
      )
      .get(path.resolve(stateDir)) as { run_id: string } | undefined;
    return row?.run_id ?? null;
  });
}

export function upsertRunIteration(params: {
  dataDir: string;
  runId: string;
  iteration: number;
  data: JsonRecord;
}): void {
  withDb(params.dataDir, (db) => {
    db.prepare(
      `
      INSERT INTO run_iterations (run_id, iteration, data_json)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, iteration) DO UPDATE SET
        data_json = excluded.data_json
      `,
    ).run(params.runId, params.iteration, JSON.stringify(params.data));
  });
}

export function listRunIterations(params: {
  dataDir: string;
  runId: string;
}): readonly { iteration: number; data: JsonRecord }[] {
  return withDb(params.dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT iteration, data_json
        FROM run_iterations
        WHERE run_id = ?
        ORDER BY iteration ASC
        `,
      )
      .all(params.runId) as { iteration: number; data_json: string }[];
    return rows.map((row) => ({
      iteration: row.iteration,
      data: parseJsonRecord(row.data_json) ?? {},
    }));
  });
}

export function appendRunLogLine(params: {
  dataDir: string;
  runId: string;
  scope: string;
  stream: string;
  line: string;
  taskId?: string;
  ts?: string;
}): number {
  const ts = params.ts ?? nowIso();
  return withDb(params.dataDir, (db) => {
    const result = db.prepare(
      `
      INSERT INTO run_log_lines (run_id, scope, task_id, stream, ts, line)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      params.runId,
      params.scope,
      params.taskId ?? '',
      params.stream,
      ts,
      params.line,
    );
    return Number(result.lastInsertRowid);
  });
}

export function listRunLogLines(params: {
  dataDir: string;
  runId: string;
  scope: string;
  stream: string;
  taskId?: string;
  afterId?: number;
  limit?: number;
}): RunLogLine[] {
  const afterId = Number.isInteger(params.afterId) ? Number(params.afterId) : 0;
  const limit = Number.isInteger(params.limit) ? Math.max(1, Number(params.limit)) : 1000;
  return withDb(params.dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT id, run_id, scope, task_id, stream, ts, line
        FROM run_log_lines
        WHERE run_id = ?
          AND scope = ?
          AND stream = ?
          AND task_id = ?
          AND id > ?
        ORDER BY id ASC
        LIMIT ?
        `,
      )
      .all(
        params.runId,
        params.scope,
        params.stream,
        params.taskId ?? '',
        afterId,
        limit,
      ) as {
      id: number;
      run_id: string;
      scope: string;
      task_id: string;
      stream: string;
      ts: string;
      line: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      scope: row.scope,
      taskId: row.task_id,
      stream: row.stream,
      ts: row.ts,
      line: row.line,
    }));
  });
}

export function appendRunSdkEvent(params: {
  dataDir: string;
  runId: string;
  scope: string;
  event: JsonRecord;
  taskId?: string;
  ts?: string;
}): number {
  const ts = params.ts ?? nowIso();
  return withDb(params.dataDir, (db) => {
    const result = db.prepare(
      `
      INSERT INTO run_sdk_events (run_id, scope, task_id, ts, event_json)
      VALUES (?, ?, ?, ?, ?)
      `,
    ).run(
      params.runId,
      params.scope,
      params.taskId ?? '',
      ts,
      JSON.stringify(params.event),
    );
    return Number(result.lastInsertRowid);
  });
}

export function listRunSdkEvents(params: {
  dataDir: string;
  runId: string;
  scope: string;
  taskId?: string;
  afterId?: number;
  limit?: number;
}): RunSdkEvent[] {
  const afterId = Number.isInteger(params.afterId) ? Number(params.afterId) : 0;
  const limit = Number.isInteger(params.limit) ? Math.max(1, Number(params.limit)) : 1000;
  return withDb(params.dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT id, run_id, scope, task_id, ts, event_json
        FROM run_sdk_events
        WHERE run_id = ?
          AND scope = ?
          AND task_id = ?
          AND id > ?
        ORDER BY id ASC
        LIMIT ?
        `,
      )
      .all(
        params.runId,
        params.scope,
        params.taskId ?? '',
        afterId,
        limit,
      ) as {
      id: number;
      run_id: string;
      scope: string;
      task_id: string;
      ts: string;
      event_json: string;
    }[];
    return rows
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        scope: row.scope,
        taskId: row.task_id,
        ts: row.ts,
        event: parseJsonRecord(row.event_json),
      }))
      .filter((row): row is RunSdkEvent => row.event !== null);
  });
}

export function upsertRunArtifact(params: {
  dataDir: string;
  runId: string;
  scope: string;
  name: string;
  mime: string;
  content: Buffer | Uint8Array;
  taskId?: string;
  createdAt?: string;
}): void {
  const createdAt = params.createdAt ?? nowIso();
  withDb(params.dataDir, (db) => {
    db.prepare(
      `
      INSERT INTO run_artifacts (run_id, scope, task_id, name, mime, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, scope, task_id, name) DO UPDATE SET
        mime = excluded.mime,
        content = excluded.content,
        created_at = excluded.created_at
      `,
    ).run(
      params.runId,
      params.scope,
      params.taskId ?? '',
      params.name,
      params.mime,
      params.content,
      createdAt,
    );
  });
}

export function readRunArtifact(params: {
  dataDir: string;
  runId: string;
  scope: string;
  name: string;
  taskId?: string;
}): RunArtifact | null {
  return withDb(params.dataDir, (db) => {
    const row = db
      .prepare(
        `
        SELECT run_id, scope, task_id, name, mime, content, created_at
        FROM run_artifacts
        WHERE run_id = ?
          AND scope = ?
          AND task_id = ?
          AND name = ?
        `,
      )
      .get(
        params.runId,
        params.scope,
        params.taskId ?? '',
        params.name,
      ) as {
      run_id: string;
      scope: string;
      task_id: string;
      name: string;
      mime: string;
      content: Buffer;
      created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      scope: row.scope,
      taskId: row.task_id,
      name: row.name,
      mime: row.mime,
      content: row.content,
      createdAt: row.created_at,
    };
  });
}

export function listRunArtifacts(params: {
  dataDir: string;
  runId: string;
  scope?: string;
  taskId?: string;
}): RunArtifact[] {
  return withDb(params.dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT run_id, scope, task_id, name, mime, content, created_at
        FROM run_artifacts
        WHERE run_id = ?
          AND (? IS NULL OR scope = ?)
          AND (? IS NULL OR task_id = ?)
        ORDER BY scope ASC, task_id ASC, name ASC
        `,
      )
      .all(
        params.runId,
        params.scope ?? null,
        params.scope ?? null,
        params.taskId ?? null,
        params.taskId ?? null,
      ) as {
      run_id: string;
      scope: string;
      task_id: string;
      name: string;
      mime: string;
      content: Buffer;
      created_at: string;
    }[];

    return rows.map((row) => ({
      runId: row.run_id,
      scope: row.scope,
      taskId: row.task_id,
      name: row.name,
      mime: row.mime,
      content: row.content,
      createdAt: row.created_at,
    }));
  });
}

export function upsertWorkerState(params: {
  dataDir: string;
  runId: string;
  taskId: string;
  stateDir: string;
  branch: string;
  worktreeDir: string;
  status: JsonRecord;
}): void {
  withDb(params.dataDir, (db) => {
    db.prepare(
      `
      INSERT INTO worker_states (run_id, task_id, state_dir, branch, worktree_dir, status_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, task_id) DO UPDATE SET
        state_dir = excluded.state_dir,
        branch = excluded.branch,
        worktree_dir = excluded.worktree_dir,
        status_json = excluded.status_json
      `,
    ).run(
      params.runId,
      params.taskId,
      path.resolve(params.stateDir),
      params.branch,
      path.resolve(params.worktreeDir),
      JSON.stringify(params.status),
    );
  });
}

export function readWorkerState(params: {
  dataDir: string;
  runId: string;
  taskId: string;
}): WorkerState | null {
  return withDb(params.dataDir, (db) => {
    const row = db
      .prepare(
        `
        SELECT run_id, task_id, state_dir, branch, worktree_dir, status_json
        FROM worker_states
        WHERE run_id = ? AND task_id = ?
        `,
      )
      .get(params.runId, params.taskId) as {
      run_id: string;
      task_id: string;
      state_dir: string;
      branch: string;
      worktree_dir: string;
      status_json: string;
    } | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      taskId: row.task_id,
      stateDir: row.state_dir,
      branch: row.branch,
      worktreeDir: row.worktree_dir,
      status: parseJsonRecord(row.status_json) ?? {},
    };
  });
}

export function listWorkerStates(params: {
  dataDir: string;
  runId: string;
}): WorkerState[] {
  return withDb(params.dataDir, (db) => {
    const rows = db
      .prepare(
        `
        SELECT run_id, task_id, state_dir, branch, worktree_dir, status_json
        FROM worker_states
        WHERE run_id = ?
        ORDER BY task_id ASC
        `,
      )
      .all(params.runId) as {
      run_id: string;
      task_id: string;
      state_dir: string;
      branch: string;
      worktree_dir: string;
      status_json: string;
    }[];
    return rows.map((row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      stateDir: row.state_dir,
      branch: row.branch,
      worktreeDir: row.worktree_dir,
      status: parseJsonRecord(row.status_json) ?? {},
    }));
  });
}

export function deleteWorkerState(params: {
  dataDir: string;
  runId: string;
  taskId: string;
}): void {
  withDb(params.dataDir, (db) => {
    db.prepare('DELETE FROM worker_states WHERE run_id = ? AND task_id = ?').run(params.runId, params.taskId);
  });
}

export function pruneRunsForStateDir(params: {
  dataDir: string;
  stateDir: string;
  keep: number;
}): number {
  const keep = Number.isInteger(params.keep) ? Math.max(1, Number(params.keep)) : 30;
  return withDb(params.dataDir, (db) => {
    const runIds = db
      .prepare(
        `
        SELECT run_id
        FROM run_sessions
        WHERE state_dir = ?
        ORDER BY started_at DESC
        `,
      )
      .all(path.resolve(params.stateDir)) as { run_id: string }[];
    if (runIds.length <= keep) return 0;
    const doomed = runIds.slice(keep).map((row) => row.run_id);
    const tx = db.transaction(() => {
      const stmt = db.prepare('DELETE FROM run_sessions WHERE run_id = ?');
      for (const runId of doomed) stmt.run(runId);
    });
    tx();
    return doomed.length;
  });
}

export function getDbHealth(dataDir: string): DbHealthSummary {
  const dbPath = dbPathForDataDir(dataDir);
  const exists = fs.existsSync(dbPath);

  return withDb(dataDir, (db) => {
    const journalMode = String(db.pragma('journal_mode', { simple: true }) ?? 'unknown');
    const foreignKeys = Number(db.pragma('foreign_keys', { simple: true }) ?? 0) === 1;
    const synchronousValue = Number(db.pragma('synchronous', { simple: true }) ?? 1);

    let synchronous = 'normal';
    if (synchronousValue === 0) synchronous = 'off';
    if (synchronousValue === 1) synchronous = 'normal';
    if (synchronousValue === 2) synchronous = 'full';
    if (synchronousValue === 3) synchronous = 'extra';

    return {
      dbPath,
      exists,
      sizeBytes: statSizeOrZero(dbPath),
      walBytes: statSizeOrZero(`${dbPath}-wal`),
      shmBytes: statSizeOrZero(`${dbPath}-shm`),
      journalMode,
      foreignKeys,
      synchronous,
    };
  });
}

export function runDbIntegrityCheck(dataDir: string): DbIntegrityResult {
  return withDb(dataDir, (db) => {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const values = rows.map((row) => row.integrity_check);
    const ok = values.length > 0 && values.every((value) => value === 'ok');
    return { ok, rows: values };
  });
}

export function runDbVacuum(dataDir: string): DbVacuumResult {
  const dbPath = dbPathForDataDir(dataDir);
  const beforeBytes = statSizeOrZero(dbPath);

  withDb(dataDir, (db) => {
    db.exec('VACUUM');
  });

  const afterBytes = statSizeOrZero(dbPath);
  return { beforeBytes, afterBytes };
}

export async function runDbBackup(dataDir: string, destinationPath: string): Promise<DbBackupResult> {
  const resolvedDestination = path.resolve(destinationPath);
  await withDbAsync(dataDir, async (db) => {
    await fsp.mkdir(path.dirname(resolvedDestination), { recursive: true });
    await db.backup(resolvedDestination);
  });

  return {
    path: resolvedDestination,
    sizeBytes: statSizeOrZero(resolvedDestination),
  };
}
