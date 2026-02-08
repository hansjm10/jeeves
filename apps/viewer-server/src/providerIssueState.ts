/**
 * Provider-aware issue metadata persistence.
 *
 * This module handles reading, writing, and validating:
 * - `issue.source.*`   — provider, kind, id, url, title, mode, hierarchy
 * - `status.issueIngest.*` — ingest summary (provider, mode, outcome, remote, warnings)
 * - `pullRequest.*`    — PR metadata (provider, external_id, branches, legacy compat)
 *
 * All writes go through validation against Section 4 constraints.
 * All reads provide legacy fallback defaults so existing issue.json records
 * remain readable without offline migration.
 *
 * Pattern: sonar token status in server.ts (read-modify-write with nested object creation).
 */

import type {
  IssueProvider,
  IngestMode,
  IngestEventOutcome,
} from './azureDevopsTypes.js';
import { VALID_ISSUE_PROVIDERS } from './azureDevopsTypes.js';
import {
  POSITIVE_INTEGER_STRING_PATTERN,
  MAX_REMOTE_URL_LENGTH,
  MAX_WARNINGS,
  MAX_WARNING_LENGTH,
} from './providerOperationJournal.js';
import { readIssueJson, writeIssueJson } from './issueJson.js';

// Re-export constants used by this module (for consumer convenience)
export { POSITIVE_INTEGER_STRING_PATTERN, MAX_REMOTE_URL_LENGTH };

// ============================================================================
// Constants
// ============================================================================

/** Maximum length for issue.source.title (trimmed). */
export const MAX_SOURCE_TITLE_LENGTH = 256;

/** Maximum number of children in issue.source.hierarchy. */
export const MAX_HIERARCHY_CHILDREN = 500;

/** Maximum number of ingest warnings. */
export const MAX_INGEST_WARNINGS = MAX_WARNINGS;

/** Maximum length of each ingest warning. */
export const MAX_INGEST_WARNING_LENGTH = MAX_WARNING_LENGTH;

/** Maximum length for git branch names. */
export const MAX_BRANCH_NAME_LENGTH = 255;

/** Valid remote item kinds. */
export const VALID_REMOTE_ITEM_KINDS: readonly RemoteItemKind[] = ['issue', 'work_item'];

/** Valid ingest modes. */
export const VALID_INGEST_MODES: readonly IngestMode[] = ['create', 'init_existing'];

/** Valid ingest outcomes (for IssueIngestStatus, which includes 'error'). */
export const VALID_INGEST_EVENT_OUTCOMES: readonly IngestEventOutcome[] = ['success', 'partial', 'error'];

// ============================================================================
// Types
// ============================================================================

/** Remote item kind. */
export type RemoteItemKind = 'issue' | 'work_item';

/** Single hierarchy item (parent or child). */
export type IssueSourceHierarchyItem = Readonly<{
  id: string;
  title: string;
  url: string;
}>;

/** Issue source hierarchy data. */
export type IssueSourceHierarchy = Readonly<{
  parent: IssueSourceHierarchyItem | null;
  children: readonly IssueSourceHierarchyItem[];
  fetched_at: string | null;
}>;

/** Provider-aware issue source metadata persisted in issue.json. */
export type IssueSource = Readonly<{
  provider: IssueProvider;
  kind: RemoteItemKind;
  id: string;
  url: string | null;
  title: string;
  mode: IngestMode;
  hierarchy?: IssueSourceHierarchy;
}>;

/** Ingest status summary persisted in issue.json (status.issueIngest). */
export type IssueIngestStatus = Readonly<{
  provider: IssueProvider;
  mode: IngestMode;
  outcome: IngestEventOutcome;
  remote_id: string | null;
  remote_url: string | null;
  warnings: readonly string[];
  auto_select_ok: boolean | null;
  auto_run_ok: boolean | null;
  occurred_at: string | null;
}>;

/** PR metadata persisted in issue.json (pullRequest). */
export type PullRequestMetadata = Readonly<{
  /** Provider that created the PR. */
  provider: IssueProvider;
  /** Provider-agnostic PR identifier as a string. */
  external_id: string;
  /** Source branch name. */
  source_branch: string;
  /** Target branch name. */
  target_branch: string;
  /** ISO-8601 UTC timestamp of last update. */
  updated_at: string | null;
  /** Legacy GitHub PR number (kept for backward compat). */
  number?: number;
  /** Legacy PR URL (kept for backward compat). */
  url?: string;
}>;

// ============================================================================
// Validation helpers (internal)
// ============================================================================

/**
 * Validate that a string is a valid positive-integer string.
 * Returns true if it matches POSITIVE_INTEGER_STRING_PATTERN.
 */
function isValidPositiveIntegerString(value: string): boolean {
  return POSITIVE_INTEGER_STRING_PATTERN.test(value);
}

/**
 * Validate that a string is an absolute https:// URL within length limits.
 */
function isAbsoluteHttpsUrl(value: string): boolean {
  if (value.length > MAX_REMOTE_URL_LENGTH) return false;
  return value.startsWith('https://') && value.length > 'https://'.length;
}

/**
 * Validate that a string looks like a valid ISO-8601 UTC timestamp.
 * Accepts formats like "2026-02-06T00:00:00.000Z" (must end with Z).
 */
function isValidIsoTimestamp(value: string): boolean {
  if (typeof value !== 'string' || value.length < 20 || value.length > 30) return false;
  if (!value.endsWith('Z')) return false;
  const d = new Date(value);
  return !isNaN(d.getTime()) && d.toISOString() === value;
}

/**
 * Validate that a value is a valid ISO-8601 UTC timestamp or null.
 */
function isValidIsoTimestampOrNull(value: string | null): boolean {
  if (value === null) return true;
  return isValidIsoTimestamp(value);
}

/**
 * Validate that a string is a valid git branch name.
 * Basic rules: length 1-255, no spaces, no control chars, no `..`, no `~`, no `^`, no `:`,
 * no backslash, no `[`, cannot end with `.lock`, cannot end with `.` or `/`, cannot start with `-`.
 */
function isValidGitBranch(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_BRANCH_NAME_LENGTH) return false;
  if (trimmed !== value) return false; // no leading/trailing whitespace

  // Forbidden patterns
  if (trimmed.startsWith('-')) return false;
  if (trimmed.endsWith('.lock')) return false;
  if (trimmed.endsWith('.')) return false;
  if (trimmed.endsWith('/')) return false;
  if (trimmed.includes('..')) return false;
  if (trimmed.includes('~')) return false;
  if (trimmed.includes('^')) return false;
  if (trimmed.includes(':')) return false;
  if (trimmed.includes('\\')) return false;
  if (trimmed.includes('[')) return false;
  if (trimmed.includes(' ')) return false;

  // No control characters
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }

  return true;
}

/**
 * Validate a hierarchy item (parent or child).
 */
function isValidHierarchyItem(item: unknown): item is IssueSourceHierarchyItem {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !isValidPositiveIntegerString(obj.id)) return false;
  if (typeof obj.title !== 'string') return false;
  if (typeof obj.url !== 'string' || !isAbsoluteHttpsUrl(obj.url)) return false;
  return true;
}

/**
 * Validate an IssueSource object.
 */
export function isValidIssueSource(source: unknown): source is IssueSource {
  if (!source || typeof source !== 'object') return false;
  const s = source as Record<string, unknown>;

  // Required fields
  if (typeof s.provider !== 'string' || !(VALID_ISSUE_PROVIDERS as readonly string[]).includes(s.provider)) return false;
  if (typeof s.kind !== 'string' || !(VALID_REMOTE_ITEM_KINDS as readonly string[]).includes(s.kind)) return false;
  if (typeof s.id !== 'string' || !isValidPositiveIntegerString(s.id)) return false;
  if (s.url !== null && (typeof s.url !== 'string' || !isAbsoluteHttpsUrl(s.url))) return false;
  if (typeof s.title !== 'string' || s.title.length > MAX_SOURCE_TITLE_LENGTH) return false;
  if (typeof s.mode !== 'string' || !(VALID_INGEST_MODES as readonly string[]).includes(s.mode)) return false;

  // Optional hierarchy
  if (s.hierarchy !== undefined) {
    if (!s.hierarchy || typeof s.hierarchy !== 'object') return false;
    const h = s.hierarchy as Record<string, unknown>;

    // parent
    if (h.parent !== null && h.parent !== undefined) {
      if (!isValidHierarchyItem(h.parent)) return false;
    }

    // children
    if (h.children !== undefined) {
      if (!Array.isArray(h.children)) return false;
      if (h.children.length > MAX_HIERARCHY_CHILDREN) return false;
      for (const child of h.children) {
        if (!isValidHierarchyItem(child)) return false;
      }
    }

    // fetched_at
    if (h.fetched_at !== null && h.fetched_at !== undefined) {
      if (typeof h.fetched_at !== 'string' || !isValidIsoTimestamp(h.fetched_at)) return false;
    }
  }

  return true;
}

/**
 * Validate an IssueIngestStatus object.
 */
export function isValidIssueIngestStatus(ingest: unknown): ingest is IssueIngestStatus {
  if (!ingest || typeof ingest !== 'object') return false;
  const s = ingest as Record<string, unknown>;

  if (typeof s.provider !== 'string' || !(VALID_ISSUE_PROVIDERS as readonly string[]).includes(s.provider)) return false;
  if (typeof s.mode !== 'string' || !(VALID_INGEST_MODES as readonly string[]).includes(s.mode)) return false;
  if (typeof s.outcome !== 'string' || !(VALID_INGEST_EVENT_OUTCOMES as readonly string[]).includes(s.outcome)) return false;

  // remote_id/remote_url: string | null
  if (s.remote_id !== null && (typeof s.remote_id !== 'string' || !isValidPositiveIntegerString(s.remote_id))) return false;
  if (s.remote_url !== null && (typeof s.remote_url !== 'string' || !isAbsoluteHttpsUrl(s.remote_url))) return false;

  // warnings
  if (!Array.isArray(s.warnings)) return false;
  if (s.warnings.length > MAX_INGEST_WARNINGS) return false;
  for (const w of s.warnings) {
    if (typeof w !== 'string' || w.length > MAX_INGEST_WARNING_LENGTH) return false;
  }

  // booleans
  if (s.auto_select_ok !== null && typeof s.auto_select_ok !== 'boolean') return false;
  if (s.auto_run_ok !== null && typeof s.auto_run_ok !== 'boolean') return false;

  // occurred_at
  if (!isValidIsoTimestampOrNull(s.occurred_at as string | null)) return false;

  return true;
}

/**
 * Validate a PullRequestMetadata object.
 */
export function isValidPullRequestMetadata(pr: unknown): pr is PullRequestMetadata {
  if (!pr || typeof pr !== 'object') return false;
  const p = pr as Record<string, unknown>;

  if (typeof p.provider !== 'string' || !(VALID_ISSUE_PROVIDERS as readonly string[]).includes(p.provider)) return false;
  if (typeof p.external_id !== 'string' || !isValidPositiveIntegerString(p.external_id)) return false;
  if (typeof p.source_branch !== 'string' || !isValidGitBranch(p.source_branch)) return false;
  if (typeof p.target_branch !== 'string' || !isValidGitBranch(p.target_branch)) return false;

  if (!isValidIsoTimestampOrNull(p.updated_at as string | null ?? null)) return false;

  // Legacy fields are optional
  if (p.number !== undefined && (typeof p.number !== 'number' || !Number.isInteger(p.number) || p.number < 1)) return false;
  if (p.url !== undefined && (typeof p.url !== 'string' || !isAbsoluteHttpsUrl(p.url))) return false;

  return true;
}

// ============================================================================
// Read helpers
// ============================================================================

/**
 * Read issue.source from issue.json with legacy fallback.
 *
 * If `issue.source.*` fields are present, returns them directly.
 * Otherwise, derives source from legacy `issue.number`, `issue.url`, `issue.title`.
 *
 * Returns null if no source data is available.
 */
export function readIssueSource(issueJson: Record<string, unknown>): IssueSource | null {
  const issue = issueJson.issue;
  if (!issue || typeof issue !== 'object') return null;
  const issueObj = issue as Record<string, unknown>;

  // Check for explicit source
  if (issueObj.source && typeof issueObj.source === 'object') {
    const raw = issueObj.source as Record<string, unknown>;
    const candidate = {
      provider: raw.provider ?? 'github',
      kind: raw.kind ?? 'issue',
      id: raw.id,
      url: raw.url ?? null,
      title: raw.title ?? '',
      mode: raw.mode ?? 'init_existing',
      ...(raw.hierarchy !== undefined ? { hierarchy: normalizeHierarchy(raw.hierarchy) } : {}),
    };
    if (isValidIssueSource(candidate)) return candidate as IssueSource;
    // If explicit source is invalid, fall through to legacy
  }

  // Legacy fallback: derive from issue.number, issue.url, issue.title
  const number = issueObj.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;

  const legacySource: IssueSource = {
    provider: 'github',
    kind: 'issue',
    id: String(number),
    url: typeof issueObj.url === 'string' ? issueObj.url : null,
    title: typeof issueObj.title === 'string' ? issueObj.title : '',
    mode: 'init_existing',
  };

  return legacySource;
}

/**
 * Normalize raw hierarchy data to IssueSourceHierarchy.
 */
function normalizeHierarchy(raw: unknown): IssueSourceHierarchy {
  if (!raw || typeof raw !== 'object') {
    return { parent: null, children: [], fetched_at: null };
  }
  const h = raw as Record<string, unknown>;
  return {
    parent: isValidHierarchyItem(h.parent) ? (h.parent as IssueSourceHierarchyItem) : null,
    children: Array.isArray(h.children) ? (h.children.filter(isValidHierarchyItem) as IssueSourceHierarchyItem[]) : [],
    fetched_at: typeof h.fetched_at === 'string' && isValidIsoTimestamp(h.fetched_at) ? h.fetched_at : null,
  };
}

/**
 * Read status.issueIngest from issue.json.
 * Returns null if not present.
 */
export function readIssueIngestStatus(issueJson: Record<string, unknown>): IssueIngestStatus | null {
  const status = issueJson.status;
  if (!status || typeof status !== 'object') return null;
  const statusObj = status as Record<string, unknown>;

  const ingest = statusObj.issueIngest;
  if (!ingest || typeof ingest !== 'object') return null;
  const raw = ingest as Record<string, unknown>;

  const candidate = {
    provider: raw.provider,
    mode: raw.mode,
    outcome: raw.outcome,
    remote_id: raw.remote_id ?? null,
    remote_url: raw.remote_url ?? null,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    auto_select_ok: raw.auto_select_ok ?? null,
    auto_run_ok: raw.auto_run_ok ?? null,
    occurred_at: raw.occurred_at ?? null,
  };

  if (isValidIssueIngestStatus(candidate)) return candidate as IssueIngestStatus;
  return null;
}

/**
 * Read pullRequest metadata from issue.json with legacy fallback.
 *
 * If `pullRequest` has new provider-aware fields, returns them directly.
 * Otherwise, derives metadata from legacy `pullRequest.number` and `pullRequest.url`.
 *
 * Returns null if no PR data is available.
 */
export function readPullRequestMetadata(issueJson: Record<string, unknown>): PullRequestMetadata | null {
  const pr = issueJson.pullRequest;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return null;
  const raw = pr as Record<string, unknown>;

  // Check for explicit provider-aware fields
  if (typeof raw.provider === 'string' && typeof raw.external_id === 'string') {
    const candidate = {
      provider: raw.provider,
      external_id: raw.external_id,
      source_branch: raw.source_branch,
      target_branch: raw.target_branch,
      updated_at: raw.updated_at ?? null,
      ...(typeof raw.number === 'number' ? { number: raw.number } : {}),
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    };
    if (isValidPullRequestMetadata(candidate)) return candidate as PullRequestMetadata;
  }

  // Legacy fallback: derive from number/url
  const legacyNumber = raw.number;
  if (typeof legacyNumber !== 'number' || !Number.isInteger(legacyNumber) || legacyNumber < 1) return null;

  // Derive source_branch from the issue's branch if available
  const issueObj = issueJson.issue as Record<string, unknown> | undefined;
  const branch = typeof issueJson.branch === 'string' ? issueJson.branch :
    typeof issueJson.branchName === 'string' ? issueJson.branchName : undefined;

  const legacyPr: PullRequestMetadata = {
    provider: 'github',
    external_id: String(legacyNumber),
    source_branch: typeof branch === 'string' ? branch : `issue/${issueObj?.number ?? legacyNumber}`,
    target_branch: 'main',
    updated_at: null,
    number: legacyNumber,
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
  };

  // Only return if valid (branch name must pass validation)
  if (isValidPullRequestMetadata(legacyPr)) return legacyPr;
  return null;
}

// ============================================================================
// Write helpers
// ============================================================================

/**
 * Write issue.source into issue.json.
 *
 * Validates the source against Section 4 constraints before persisting.
 * Also syncs `issue.number`, `issue.url`, `issue.title` for legacy compat.
 *
 * @throws Error if source fails validation.
 */
export async function writeIssueSource(stateDir: string, source: IssueSource): Promise<void> {
  if (!isValidIssueSource(source)) {
    throw new Error('Invalid IssueSource: fails Section 4 constraints');
  }

  const issueJson = (await readIssueJson(stateDir)) ?? {};

  // Ensure issue object exists
  if (!issueJson.issue || typeof issueJson.issue !== 'object') {
    issueJson.issue = {} as Record<string, unknown>;
  }
  const issue = issueJson.issue as Record<string, unknown>;

  // Write source metadata
  issue.source = { ...source };

  // Sync legacy fields for backward compat
  issue.number = parseInt(source.id, 10);
  if (source.url !== null) {
    issue.url = source.url;
  }
  if (source.title) {
    issue.title = source.title;
  }

  await writeIssueJson(stateDir, issueJson);
}

/**
 * Write status.issueIngest into issue.json.
 *
 * Validates the ingest status against Section 4 constraints before persisting.
 *
 * @throws Error if ingest status fails validation.
 */
export async function writeIssueIngestStatus(stateDir: string, ingest: IssueIngestStatus): Promise<void> {
  if (!isValidIssueIngestStatus(ingest)) {
    throw new Error('Invalid IssueIngestStatus: fails Section 4 constraints');
  }

  const issueJson = (await readIssueJson(stateDir)) ?? {};

  // Ensure status object exists
  if (!issueJson.status || typeof issueJson.status !== 'object') {
    issueJson.status = {};
  }
  const status = issueJson.status as Record<string, unknown>;

  // Write ingest status
  status.issueIngest = { ...ingest };

  await writeIssueJson(stateDir, issueJson);
}

/**
 * Write pullRequest metadata into issue.json.
 *
 * Validates the PR metadata against Section 4 constraints before persisting.
 * Sets `status.prCreated = true` atomically with the PR metadata.
 *
 * @throws Error if PR metadata fails validation.
 */
export async function writePullRequestMetadata(stateDir: string, pr: PullRequestMetadata): Promise<void> {
  if (!isValidPullRequestMetadata(pr)) {
    throw new Error('Invalid PullRequestMetadata: fails Section 4 constraints');
  }

  const issueJson = (await readIssueJson(stateDir)) ?? {};

  // Write pullRequest metadata
  issueJson.pullRequest = { ...pr };

  // Ensure status object exists
  if (!issueJson.status || typeof issueJson.status !== 'object') {
    issueJson.status = {};
  }
  const status = issueJson.status as Record<string, unknown>;

  // Set prCreated = true atomically with PR metadata
  status.prCreated = true;

  await writeIssueJson(stateDir, issueJson);
}

// ============================================================================
// Exports for validation (used by consumers who need standalone validation)
// ============================================================================

export {
  isValidGitBranch,
  isValidIsoTimestamp,
  isAbsoluteHttpsUrl,
  isValidPositiveIntegerString,
  isValidHierarchyItem,
};
