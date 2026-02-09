import { clearActiveIssueFromDb, loadActiveIssueFromDb, saveActiveIssueToDb } from './sqliteStorage.js';

export type ActiveIssueState = Readonly<{ issue_ref: string; saved_at: string }>;

function nowIso(): string {
  return new Date().toISOString();
}

export async function saveActiveIssue(dataDir: string, issueRef: string): Promise<void> {
  const savedAt = nowIso();
  saveActiveIssueToDb(dataDir, issueRef, savedAt);
}

export async function loadActiveIssue(dataDir: string): Promise<string | null> {
  return loadActiveIssueFromDb(dataDir);
}

export async function clearActiveIssue(dataDir: string): Promise<void> {
  clearActiveIssueFromDb(dataDir);
}
