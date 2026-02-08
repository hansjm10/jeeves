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
  return readIssueFromDb(stateDir);
}

export async function writeIssueJson(stateDir: string, data: Record<string, unknown>): Promise<void> {
  writeIssueToDb(stateDir, data);
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
  return readIssueUpdatedAtMs(stateDir);
}
