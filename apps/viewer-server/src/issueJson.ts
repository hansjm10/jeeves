import fs from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from './jsonAtomic.js';
import {
  listIssuesFromDb,
  readIssueFromDb,
  readIssueUpdatedAtMs,
  writeIssueToDb,
  type StoredIssueSummary,
} from './sqliteStorage.js';

export type IssueJsonListItem = Readonly<{
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  branch: string;
  phase: string;
  stateDir: string;
  updatedAt: string;
}>;

export async function readIssueJson(stateDir: string): Promise<Record<string, unknown> | null> {
  const dbUpdatedAtMs = readIssueUpdatedAtMs(stateDir);
  const fromDb = readIssueFromDb(stateDir);

  const issuePath = path.join(stateDir, 'issue.json');
  const stat = await fs.stat(issuePath).catch(() => null);
  if (fromDb && (!stat || !stat.isFile() || stat.mtimeMs <= dbUpdatedAtMs)) {
    return fromDb;
  }

  const raw = await fs
    .readFile(issuePath, 'utf-8')
    .catch(() => null);
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        const issueJson = parsed as Record<string, unknown>;
        if (!fromDb || (stat && stat.isFile() && stat.mtimeMs > dbUpdatedAtMs)) {
          writeIssueToDb(stateDir, issueJson);
        }
        return issueJson;
      }
    } catch {
      // ignore
    }
  }

  return readIssueFromDb(stateDir);
}

export async function writeIssueJson(stateDir: string, data: Record<string, unknown>): Promise<void> {
  writeIssueToDb(stateDir, data);
  const issuePath = path.join(stateDir, 'issue.json');
  await writeJsonAtomic(issuePath, data);
}

function toIssueJsonListItem(row: StoredIssueSummary): IssueJsonListItem {
  return {
    owner: row.owner,
    repo: row.repo,
    issueNumber: row.issueNumber,
    issueTitle: row.issueTitle,
    branch: row.branch,
    phase: row.phase,
    stateDir: row.stateDir,
    updatedAt: row.updatedAt,
  };
}

export async function listIssueJsonStates(dataDir: string): Promise<IssueJsonListItem[]> {
  return listIssuesFromDb(dataDir).map(toIssueJsonListItem);
}

export async function readIssueJsonUpdatedAtMs(stateDir: string): Promise<number> {
  const fromDb = readIssueUpdatedAtMs(stateDir);
  const issuePath = path.join(stateDir, 'issue.json');
  const stat = await fs.stat(issuePath).catch(() => null);
  const fromFile = stat && stat.isFile() ? stat.mtimeMs : 0;
  return Math.max(fromDb, fromFile);
}
