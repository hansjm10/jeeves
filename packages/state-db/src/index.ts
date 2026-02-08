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
