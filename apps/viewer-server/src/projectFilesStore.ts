import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PROJECT_FILES_SCHEMA_VERSION,
  PROJECT_FILE_MAX_COUNT,
  type ProjectFileRecord,
  type ProjectFilesIndex,
} from './projectFilesTypes.js';

const REPO_FILES_DIR = 'repo-files';
const BLOBS_DIR = 'blobs';
const INDEX_FILE = 'index.json';
const FILE_MODE = 0o600;

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value !== null && typeof value === 'object' && 'code' in value;
}

function generateId(): string {
  // 32 hex chars, safe for filenames and URLs.
  return crypto.randomBytes(16).toString('hex');
}

function getNow(): string {
  return new Date().toISOString();
}

function assertValidRecord(value: unknown): value is ProjectFileRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' && obj.id.length > 0 &&
    typeof obj.display_name === 'string' && obj.display_name.length > 0 &&
    typeof obj.target_path === 'string' && obj.target_path.length > 0 &&
    typeof obj.storage_relpath === 'string' && obj.storage_relpath.length > 0 &&
    typeof obj.size_bytes === 'number' && Number.isInteger(obj.size_bytes) && obj.size_bytes >= 0 &&
    typeof obj.sha256 === 'string' && obj.sha256.length > 0 &&
    typeof obj.updated_at === 'string' && obj.updated_at.length > 0
  );
}

function assertValidIndex(value: unknown): value is ProjectFilesIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== PROJECT_FILES_SCHEMA_VERSION) return false;
  if (!Array.isArray(obj.files)) return false;
  return obj.files.every(assertValidRecord);
}

export function getRepoProjectFilesDir(dataDir: string, owner: string, repo: string): string {
  return path.join(dataDir, REPO_FILES_DIR, owner, repo);
}

export function getRepoProjectFilesBlobsDir(dataDir: string, owner: string, repo: string): string {
  return path.join(getRepoProjectFilesDir(dataDir, owner, repo), BLOBS_DIR);
}

export function getRepoProjectFilesIndexPath(dataDir: string, owner: string, repo: string): string {
  return path.join(getRepoProjectFilesDir(dataDir, owner, repo), INDEX_FILE);
}

function buildEmptyIndex(): ProjectFilesIndex {
  return {
    schemaVersion: PROJECT_FILES_SCHEMA_VERSION,
    files: [],
  };
}

export async function readProjectFilesIndex(dataDir: string, owner: string, repo: string): Promise<ProjectFilesIndex> {
  const indexPath = getRepoProjectFilesIndexPath(dataDir, owner, repo);

  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return buildEmptyIndex();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid project files index JSON.');
  }

  if (!assertValidIndex(parsed)) {
    throw new Error('Invalid project files index schema.');
  }

  return parsed;
}

async function writeProjectFilesIndex(
  dataDir: string,
  owner: string,
  repo: string,
  index: ProjectFilesIndex,
): Promise<void> {
  const repoDir = getRepoProjectFilesDir(dataDir, owner, repo);
  const indexPath = getRepoProjectFilesIndexPath(dataDir, owner, repo);
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;

  await fs.mkdir(repoDir, { recursive: true });
  const content = JSON.stringify(index, null, 2) + '\n';
  await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode: FILE_MODE });
  try {
    await fs.chmod(tempPath, FILE_MODE);
  } catch {
    // Ignore on platforms without chmod support.
  }

  try {
    await fs.rename(tempPath, indexPath);
  } catch {
    await fs.rm(indexPath, { force: true }).catch(() => void 0);
    await fs.rename(tempPath, indexPath);
  }

  try {
    await fs.chmod(indexPath, FILE_MODE);
  } catch {
    // Ignore on platforms without chmod support.
  }
}

async function writeBlobFile(blobPath: string, content: Buffer): Promise<void> {
  const tempPath = `${blobPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, { mode: FILE_MODE });
  try {
    await fs.chmod(tempPath, FILE_MODE);
  } catch {
    // Ignore on platforms without chmod support.
  }

  try {
    await fs.rename(tempPath, blobPath);
  } catch {
    await fs.rm(blobPath, { force: true }).catch(() => void 0);
    await fs.rename(tempPath, blobPath);
  }

  try {
    await fs.chmod(blobPath, FILE_MODE);
  } catch {
    // Ignore on platforms without chmod support.
  }
}

function makeRecord(params: {
  id: string;
  displayName: string;
  targetPath: string;
  sizeBytes: number;
  sha256: string;
}): ProjectFileRecord {
  return {
    id: params.id,
    display_name: params.displayName,
    target_path: params.targetPath,
    storage_relpath: `${BLOBS_DIR}/${params.id}`,
    size_bytes: params.sizeBytes,
    sha256: params.sha256,
    updated_at: getNow(),
  };
}

export async function upsertProjectFile(params: {
  dataDir: string;
  owner: string;
  repo: string;
  id?: string;
  displayName: string;
  targetPath: string;
  content: Buffer;
}): Promise<{ record: ProjectFileRecord; created: boolean }> {
  const index = await readProjectFilesIndex(params.dataDir, params.owner, params.repo);
  const files = [...index.files];

  const existingIdIndex = params.id
    ? files.findIndex((f) => f.id === params.id)
    : -1;

  const targetConflict = files.find(
    (f, idx) => f.target_path === params.targetPath && idx !== existingIdIndex,
  );
  if (targetConflict) {
    throw new Error(`target_path already exists: ${params.targetPath}`);
  }

  const created = existingIdIndex === -1;
  if (created && files.length >= PROJECT_FILE_MAX_COUNT) {
    throw new Error(`Maximum of ${PROJECT_FILE_MAX_COUNT} files per repo exceeded.`);
  }

  const id = created ? (params.id ?? generateId()) : files[existingIdIndex]!.id;
  const sha256 = crypto.createHash('sha256').update(params.content).digest('hex');
  const nextRecord = makeRecord({
    id,
    displayName: params.displayName,
    targetPath: params.targetPath,
    sizeBytes: params.content.length,
    sha256,
  });

  const blobsDir = getRepoProjectFilesBlobsDir(params.dataDir, params.owner, params.repo);
  await fs.mkdir(blobsDir, { recursive: true });
  const blobPath = path.join(blobsDir, id);
  await writeBlobFile(blobPath, params.content);

  if (created) {
    files.push(nextRecord);
  } else {
    files[existingIdIndex] = nextRecord;
  }

  files.sort((a, b) => a.target_path.localeCompare(b.target_path));
  await writeProjectFilesIndex(params.dataDir, params.owner, params.repo, {
    schemaVersion: PROJECT_FILES_SCHEMA_VERSION,
    files,
  });

  return { record: nextRecord, created };
}

export async function deleteProjectFile(params: {
  dataDir: string;
  owner: string;
  repo: string;
  id: string;
}): Promise<{ deleted: boolean; removed: ProjectFileRecord | null }> {
  const index = await readProjectFilesIndex(params.dataDir, params.owner, params.repo);
  const files = [...index.files];
  const idx = files.findIndex((f) => f.id === params.id);
  if (idx === -1) {
    return { deleted: false, removed: null };
  }

  const [removed] = files.splice(idx, 1);
  await writeProjectFilesIndex(params.dataDir, params.owner, params.repo, {
    schemaVersion: PROJECT_FILES_SCHEMA_VERSION,
    files,
  });

  const blobPath = path.join(getRepoProjectFilesDir(params.dataDir, params.owner, params.repo), removed.storage_relpath);
  await fs.rm(blobPath, { force: true }).catch(() => void 0);

  return { deleted: true, removed };
}

export async function listProjectFiles(dataDir: string, owner: string, repo: string): Promise<readonly ProjectFileRecord[]> {
  const index = await readProjectFilesIndex(dataDir, owner, repo);
  return [...index.files].sort((a, b) => a.target_path.localeCompare(b.target_path));
}
