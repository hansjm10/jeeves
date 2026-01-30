import fs from 'node:fs/promises';
import path from 'node:path';

export type ActiveIssueState = Readonly<{ issue_ref: string; saved_at: string }>;

function nowIso(): string {
  return new Date().toISOString();
}

export function getActiveIssueFile(dataDir: string): string {
  return path.join(dataDir, 'active-issue.json');
}

export async function saveActiveIssue(dataDir: string, issueRef: string): Promise<void> {
  const filePath = getActiveIssueFile(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const content: ActiveIssueState = { issue_ref: issueRef, saved_at: nowIso() };
  await fs.writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
}

export async function loadActiveIssue(dataDir: string): Promise<string | null> {
  const filePath = getActiveIssueFile(dataDir);
  const raw = await fs
    .readFile(filePath, 'utf-8')
    .catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveIssueState>;
    if (typeof parsed.issue_ref === 'string' && parsed.issue_ref.trim()) return parsed.issue_ref.trim();
  } catch {
    // ignore
  }
  return null;
}

