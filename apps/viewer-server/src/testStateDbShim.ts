import fs from 'node:fs/promises';
import path from 'node:path';

import {
  loadActiveIssueFromDb,
  readIssueFromDb,
  readTasksFromDb,
  saveActiveIssueToDb,
  writeIssueToDb,
  writeTasksToDb,
} from './sqliteStorage.js';

type ShimKind = 'issue' | 'tasks' | 'active' | null;
type FsAny = {
  readFile: (...args: unknown[]) => Promise<unknown>;
  writeFile: (...args: unknown[]) => Promise<unknown>;
  rename: (...args: unknown[]) => Promise<unknown>;
};

function getShimKind(filePath: string): ShimKind {
  const base = path.basename(filePath);
  if (base === 'issue.json') return 'issue';
  if (base === 'tasks.json') return 'tasks';
  if (base === 'active-issue.json') return 'active';
  return null;
}

function toUtf8Text(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
  }
  return null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function encodeForRead(options: unknown, text: string): string | Buffer {
  if (typeof options === 'string') return text;
  if (options && typeof options === 'object') {
    const encoding = (options as { encoding?: unknown }).encoding;
    if (typeof encoding === 'string' && encoding.length > 0) return text;
  }
  return Buffer.from(text, 'utf-8');
}

async function syncFromText(filePath: string, text: string): Promise<void> {
  const kind = getShimKind(filePath);
  if (!kind) return;

  const parsed = parseJsonRecord(text);
  if (!parsed) return;

  if (kind === 'issue') {
    writeIssueToDb(path.dirname(filePath), parsed);
    return;
  }
  if (kind === 'tasks') {
    writeTasksToDb(path.dirname(filePath), parsed);
    return;
  }
  const issueRefRaw = parsed.issue_ref;
  const issueRef = typeof issueRefRaw === 'string' ? issueRefRaw.trim() : '';
  if (!issueRef) return;
  const savedAtRaw = parsed.saved_at;
  const savedAt = typeof savedAtRaw === 'string' && savedAtRaw.trim().length > 0
    ? savedAtRaw
    : new Date().toISOString();
  saveActiveIssueToDb(path.dirname(filePath), issueRef, savedAt);
}

const fsAny = fs as unknown as FsAny;
let installCount = 0;
let originalReadFile: FsAny['readFile'] | null = null;
let originalWriteFile: FsAny['writeFile'] | null = null;
let originalRename: FsAny['rename'] | null = null;

export function installStateDbFsShim(): () => void {
  if (installCount === 0) {
    originalReadFile = fsAny.readFile.bind(fsAny) as FsAny['readFile'];
    originalWriteFile = fsAny.writeFile.bind(fsAny) as FsAny['writeFile'];
    originalRename = fsAny.rename.bind(fsAny) as FsAny['rename'];

    fsAny.writeFile = (async (file: unknown, data: unknown, options?: unknown): Promise<unknown> => {
      const writeImpl = originalWriteFile;
      if (!writeImpl) throw new Error('writeFile shim missing original implementation');
      const result = await writeImpl(file, data, options);
      if (typeof file === 'string') {
        const text = toUtf8Text(data);
        if (text !== null) await syncFromText(path.resolve(file), text);
      }
      return result;
    }) as FsAny['writeFile'];

    fsAny.rename = (async (oldPath: unknown, newPath: unknown): Promise<unknown> => {
      const renameImpl = originalRename;
      const readImpl = originalReadFile;
      if (!renameImpl || !readImpl) throw new Error('rename shim missing original implementation');
      const result = await renameImpl(oldPath, newPath);
      if (typeof newPath === 'string') {
        const kind = getShimKind(newPath);
        if (kind) {
          const text = (await readImpl(newPath, 'utf-8')) as string;
          await syncFromText(path.resolve(newPath), text);
        }
      }
      return result;
    }) as FsAny['rename'];

    fsAny.readFile = (async (file: unknown, options?: unknown): Promise<unknown> => {
      const readImpl = originalReadFile;
      if (!readImpl) throw new Error('readFile shim missing original implementation');
      if (typeof file !== 'string') {
        return readImpl(file, options);
      }
      const resolved = path.resolve(file);
      const kind = getShimKind(resolved);
      if (!kind) return readImpl(file, options);

      if (kind === 'issue') {
        const issue = readIssueFromDb(path.dirname(resolved));
        if (issue) {
          const text = `${JSON.stringify(issue, null, 2)}\n`;
          return encodeForRead(options, text);
        }
        return readImpl(file, options);
      }

      if (kind === 'tasks') {
        const tasks = readTasksFromDb(path.dirname(resolved));
        if (tasks) {
          const text = `${JSON.stringify(tasks, null, 2)}\n`;
          return encodeForRead(options, text);
        }
        return readImpl(file, options);
      }

      const activeIssue = loadActiveIssueFromDb(path.dirname(resolved));
      if (activeIssue) {
        const text = `${JSON.stringify({ issue_ref: activeIssue, saved_at: new Date().toISOString() }, null, 2)}\n`;
        return encodeForRead(options, text);
      }
      return readImpl(file, options);
    }) as FsAny['readFile'];
  }

  installCount += 1;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    installCount = Math.max(0, installCount - 1);
    if (installCount !== 0) return;
    if (originalReadFile) fsAny.readFile = originalReadFile;
    if (originalWriteFile) fsAny.writeFile = originalWriteFile;
    if (originalRename) fsAny.rename = originalRename;
    originalReadFile = null;
    originalWriteFile = null;
    originalRename = null;
  };
}
