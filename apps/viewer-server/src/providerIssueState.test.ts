import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  // Types
  type IssueSource,
  type IssueIngestStatus,
  type PullRequestMetadata,

  // Read helpers
  readIssueSource,
  readIssueIngestStatus,
  readPullRequestMetadata,

  // Write helpers
  writeIssueSource,
  writeIssueIngestStatus,
  writePullRequestMetadata,

  // Validation helpers
  isValidIssueSource,
  isValidIssueIngestStatus,
  isValidPullRequestMetadata,
  isValidGitBranch,
  isValidIsoTimestamp,
  isAbsoluteHttpsUrl,
  isValidPositiveIntegerString,
  isValidHierarchyItem,

  // Constants
  MAX_SOURCE_TITLE_LENGTH,
  MAX_HIERARCHY_CHILDREN,
  MAX_INGEST_WARNINGS,
  MAX_INGEST_WARNING_LENGTH,
  MAX_BRANCH_NAME_LENGTH,
  POSITIVE_INTEGER_STRING_PATTERN,
  MAX_REMOTE_URL_LENGTH,
} from './providerIssueState.js';

// ============================================================================
// Test helpers
// ============================================================================

describe('providerIssueState', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-issue-state-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => void 0);
  });

  /** Write a raw issue.json for test setup. */
  async function writeRawIssueJson(data: Record<string, unknown>): Promise<void> {
    await fs.writeFile(path.join(tempDir, 'issue.json'), JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Read raw issue.json for verification. */
  async function readRawIssueJson(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(path.join(tempDir, 'issue.json'), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /** A valid IssueSource for reuse in tests. */
  const VALID_SOURCE: IssueSource = {
    provider: 'github',
    kind: 'issue',
    id: '42',
    url: 'https://github.com/owner/repo/issues/42',
    title: 'Test issue',
    mode: 'init_existing',
  };

  /** A valid IssueIngestStatus for reuse in tests. */
  const VALID_INGEST: IssueIngestStatus = {
    provider: 'azure_devops',
    mode: 'create',
    outcome: 'success',
    remote_id: '100',
    remote_url: 'https://dev.azure.com/org/project/_workitems/edit/100',
    warnings: [],
    auto_select_ok: true,
    auto_run_ok: null,
    occurred_at: '2026-02-06T00:00:00.000Z',
  };

  /** A valid PullRequestMetadata for reuse in tests. */
  const VALID_PR: PullRequestMetadata = {
    provider: 'github',
    external_id: '99',
    source_branch: 'issue/42',
    target_branch: 'main',
    updated_at: '2026-02-06T12:00:00.000Z',
    number: 99,
    url: 'https://github.com/owner/repo/pull/99',
  };

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe('constants', () => {
    it('exports expected constraint values', () => {
      expect(MAX_SOURCE_TITLE_LENGTH).toBe(256);
      expect(MAX_HIERARCHY_CHILDREN).toBe(500);
      expect(MAX_INGEST_WARNINGS).toBe(50);
      expect(MAX_INGEST_WARNING_LENGTH).toBe(512);
      expect(MAX_BRANCH_NAME_LENGTH).toBe(255);
      expect(MAX_REMOTE_URL_LENGTH).toBe(2048);
      expect(POSITIVE_INTEGER_STRING_PATTERN.source).toBe('^[1-9][0-9]{0,18}$');
    });
  });

  // ==========================================================================
  // Validation: isValidPositiveIntegerString
  // ==========================================================================

  describe('isValidPositiveIntegerString', () => {
    it('accepts valid positive-integer strings', () => {
      expect(isValidPositiveIntegerString('1')).toBe(true);
      expect(isValidPositiveIntegerString('42')).toBe(true);
      expect(isValidPositiveIntegerString('1234567890123456789')).toBe(true);
    });

    it('rejects invalid values', () => {
      expect(isValidPositiveIntegerString('0')).toBe(false);
      expect(isValidPositiveIntegerString('')).toBe(false);
      expect(isValidPositiveIntegerString('01')).toBe(false);
      expect(isValidPositiveIntegerString('-1')).toBe(false);
      expect(isValidPositiveIntegerString('abc')).toBe(false);
      expect(isValidPositiveIntegerString('12345678901234567890')).toBe(false); // 20 digits
    });
  });

  // ==========================================================================
  // Validation: isAbsoluteHttpsUrl
  // ==========================================================================

  describe('isAbsoluteHttpsUrl', () => {
    it('accepts valid https URLs', () => {
      expect(isAbsoluteHttpsUrl('https://example.com')).toBe(true);
      expect(isAbsoluteHttpsUrl('https://github.com/owner/repo/issues/1')).toBe(true);
    });

    it('rejects invalid URLs', () => {
      expect(isAbsoluteHttpsUrl('http://example.com')).toBe(false);
      expect(isAbsoluteHttpsUrl('https://')).toBe(false);
      expect(isAbsoluteHttpsUrl('ftp://example.com')).toBe(false);
      expect(isAbsoluteHttpsUrl('')).toBe(false);
      expect(isAbsoluteHttpsUrl('not-a-url')).toBe(false);
    });

    it('rejects URLs exceeding max length', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(MAX_REMOTE_URL_LENGTH);
      expect(isAbsoluteHttpsUrl(longUrl)).toBe(false);
    });
  });

  // ==========================================================================
  // Validation: isValidIsoTimestamp
  // ==========================================================================

  describe('isValidIsoTimestamp', () => {
    it('accepts valid ISO-8601 UTC timestamps', () => {
      expect(isValidIsoTimestamp('2026-02-06T00:00:00.000Z')).toBe(true);
      expect(isValidIsoTimestamp(new Date().toISOString())).toBe(true);
    });

    it('rejects invalid timestamps', () => {
      expect(isValidIsoTimestamp('not-a-date')).toBe(false);
      expect(isValidIsoTimestamp('2026-02-06')).toBe(false);
      expect(isValidIsoTimestamp('2026-02-06T00:00:00+05:00')).toBe(false); // not UTC
      expect(isValidIsoTimestamp('')).toBe(false);
    });
  });

  // ==========================================================================
  // Validation: isValidGitBranch
  // ==========================================================================

  describe('isValidGitBranch', () => {
    it('accepts valid branch names', () => {
      expect(isValidGitBranch('main')).toBe(true);
      expect(isValidGitBranch('issue/42')).toBe(true);
      expect(isValidGitBranch('feature/my-feature')).toBe(true);
      expect(isValidGitBranch('a')).toBe(true);
    });

    it('rejects invalid branch names', () => {
      expect(isValidGitBranch('')).toBe(false);
      expect(isValidGitBranch('-starts-with-dash')).toBe(false);
      expect(isValidGitBranch('has spaces')).toBe(false);
      expect(isValidGitBranch('has..dots')).toBe(false);
      expect(isValidGitBranch('has~tilde')).toBe(false);
      expect(isValidGitBranch('has^caret')).toBe(false);
      expect(isValidGitBranch('has:colon')).toBe(false);
      expect(isValidGitBranch('has\\backslash')).toBe(false);
      expect(isValidGitBranch('has[bracket')).toBe(false);
      expect(isValidGitBranch('ends.lock')).toBe(false);
      expect(isValidGitBranch('ends.')).toBe(false);
      expect(isValidGitBranch('ends/')).toBe(false);
      expect(isValidGitBranch(' leading-space')).toBe(false);
      expect(isValidGitBranch('trailing-space ')).toBe(false);
    });

    it('rejects branch names exceeding max length', () => {
      expect(isValidGitBranch('a'.repeat(256))).toBe(false);
      expect(isValidGitBranch('a'.repeat(255))).toBe(true);
    });
  });

  // ==========================================================================
  // Validation: isValidHierarchyItem
  // ==========================================================================

  describe('isValidHierarchyItem', () => {
    it('accepts valid hierarchy items', () => {
      expect(isValidHierarchyItem({ id: '1', title: 'Parent', url: 'https://example.com/1' })).toBe(true);
    });

    it('rejects items with invalid id', () => {
      expect(isValidHierarchyItem({ id: '0', title: 'X', url: 'https://example.com/0' })).toBe(false);
      expect(isValidHierarchyItem({ id: 'abc', title: 'X', url: 'https://example.com/x' })).toBe(false);
    });

    it('rejects items with invalid url', () => {
      expect(isValidHierarchyItem({ id: '1', title: 'X', url: 'http://example.com/1' })).toBe(false);
    });

    it('rejects non-objects and missing fields', () => {
      expect(isValidHierarchyItem(null)).toBe(false);
      expect(isValidHierarchyItem(undefined)).toBe(false);
      expect(isValidHierarchyItem({ id: '1' })).toBe(false); // missing title and url
    });
  });

  // ==========================================================================
  // Validation: isValidIssueSource
  // ==========================================================================

  describe('isValidIssueSource', () => {
    it('accepts a valid source', () => {
      expect(isValidIssueSource(VALID_SOURCE)).toBe(true);
    });

    it('accepts azure_devops provider with work_item kind', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, provider: 'azure_devops', kind: 'work_item' })).toBe(true);
    });

    it('accepts source with null url', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, url: null })).toBe(true);
    });

    it('accepts source with hierarchy', () => {
      const withHierarchy = {
        ...VALID_SOURCE,
        hierarchy: {
          parent: { id: '1', title: 'Parent', url: 'https://example.com/1' },
          children: [{ id: '2', title: 'Child', url: 'https://example.com/2' }],
          fetched_at: '2026-02-06T00:00:00.000Z',
        },
      };
      expect(isValidIssueSource(withHierarchy)).toBe(true);
    });

    it('rejects invalid provider', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, provider: 'gitlab' })).toBe(false);
    });

    it('rejects invalid kind', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, kind: 'task' })).toBe(false);
    });

    it('rejects invalid id', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, id: '0' })).toBe(false);
      expect(isValidIssueSource({ ...VALID_SOURCE, id: 'abc' })).toBe(false);
    });

    it('rejects invalid url', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, url: 'http://insecure.com' })).toBe(false);
    });

    it('rejects title exceeding max length', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, title: 'x'.repeat(257) })).toBe(false);
    });

    it('rejects invalid mode', () => {
      expect(isValidIssueSource({ ...VALID_SOURCE, mode: 'import' })).toBe(false);
    });

    it('rejects hierarchy with too many children', () => {
      const tooMany = Array.from({ length: 501 }, (_, i) => ({
        id: String(i + 1),
        title: `Child ${i + 1}`,
        url: `https://example.com/${i + 1}`,
      }));
      expect(isValidIssueSource({ ...VALID_SOURCE, hierarchy: { parent: null, children: tooMany, fetched_at: null } })).toBe(false);
    });

    it('rejects hierarchy with invalid parent', () => {
      expect(isValidIssueSource({
        ...VALID_SOURCE,
        hierarchy: { parent: { id: '0', title: 'Bad', url: 'https://example.com/0' }, children: [], fetched_at: null },
      })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isValidIssueSource(null)).toBe(false);
      expect(isValidIssueSource('string')).toBe(false);
      expect(isValidIssueSource(42)).toBe(false);
    });
  });

  // ==========================================================================
  // Validation: isValidIssueIngestStatus
  // ==========================================================================

  describe('isValidIssueIngestStatus', () => {
    it('accepts a valid ingest status', () => {
      expect(isValidIssueIngestStatus(VALID_INGEST)).toBe(true);
    });

    it('accepts error outcome', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, outcome: 'error', remote_id: null, remote_url: null })).toBe(true);
    });

    it('accepts partial outcome', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, outcome: 'partial' })).toBe(true);
    });

    it('accepts null remote fields', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, remote_id: null, remote_url: null })).toBe(true);
    });

    it('rejects invalid provider', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, provider: 'gitlab' })).toBe(false);
    });

    it('rejects invalid mode', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, mode: 'import' })).toBe(false);
    });

    it('rejects invalid outcome', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, outcome: 'timeout' })).toBe(false);
    });

    it('rejects invalid remote_id', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, remote_id: '0' })).toBe(false);
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, remote_id: 'abc' })).toBe(false);
    });

    it('rejects invalid remote_url', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, remote_url: 'http://insecure.com' })).toBe(false);
    });

    it('rejects too many warnings', () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => `Warning ${i}`);
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, warnings: tooMany })).toBe(false);
    });

    it('rejects warning exceeding max length', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, warnings: ['x'.repeat(513)] })).toBe(false);
    });

    it('rejects invalid occurred_at', () => {
      expect(isValidIssueIngestStatus({ ...VALID_INGEST, occurred_at: 'not-a-date' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isValidIssueIngestStatus(null)).toBe(false);
      expect(isValidIssueIngestStatus(undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // Validation: isValidPullRequestMetadata
  // ==========================================================================

  describe('isValidPullRequestMetadata', () => {
    it('accepts a valid PR', () => {
      expect(isValidPullRequestMetadata(VALID_PR)).toBe(true);
    });

    it('accepts PR without legacy fields', () => {
      const prWithoutLegacy = {
        provider: VALID_PR.provider,
        external_id: VALID_PR.external_id,
        source_branch: VALID_PR.source_branch,
        target_branch: VALID_PR.target_branch,
        updated_at: VALID_PR.updated_at,
      };
      expect(isValidPullRequestMetadata(prWithoutLegacy)).toBe(true);
    });

    it('accepts azure_devops provider', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, provider: 'azure_devops' })).toBe(true);
    });

    it('accepts null updated_at', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, updated_at: null })).toBe(true);
    });

    it('rejects invalid provider', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, provider: 'gitlab' })).toBe(false);
    });

    it('rejects invalid external_id', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, external_id: '0' })).toBe(false);
      expect(isValidPullRequestMetadata({ ...VALID_PR, external_id: 'abc' })).toBe(false);
    });

    it('rejects invalid source_branch', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, source_branch: '' })).toBe(false);
      expect(isValidPullRequestMetadata({ ...VALID_PR, source_branch: 'has spaces' })).toBe(false);
    });

    it('rejects invalid target_branch', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, target_branch: 'has..dots' })).toBe(false);
    });

    it('rejects branch names exceeding max length', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, source_branch: 'a'.repeat(256) })).toBe(false);
    });

    it('rejects invalid updated_at', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, updated_at: 'not-a-date' })).toBe(false);
    });

    it('rejects invalid legacy number', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, number: 0 })).toBe(false);
      expect(isValidPullRequestMetadata({ ...VALID_PR, number: -1 })).toBe(false);
      expect(isValidPullRequestMetadata({ ...VALID_PR, number: 1.5 })).toBe(false);
    });

    it('rejects invalid legacy url', () => {
      expect(isValidPullRequestMetadata({ ...VALID_PR, url: 'http://insecure.com' })).toBe(false);
    });

    it('rejects non-objects', () => {
      expect(isValidPullRequestMetadata(null)).toBe(false);
      expect(isValidPullRequestMetadata(undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // Read: readIssueSource
  // ==========================================================================

  describe('readIssueSource', () => {
    it('returns explicit source fields when present', () => {
      const issueJson: Record<string, unknown> = {
        issue: {
          number: 42,
          source: {
            provider: 'azure_devops',
            kind: 'work_item',
            id: '100',
            url: 'https://dev.azure.com/org/proj/_workitems/edit/100',
            title: 'Work item',
            mode: 'create',
          },
        },
      };
      const result = readIssueSource(issueJson);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('azure_devops');
      expect(result!.kind).toBe('work_item');
      expect(result!.id).toBe('100');
      expect(result!.mode).toBe('create');
    });

    it('returns source with hierarchy', () => {
      const issueJson: Record<string, unknown> = {
        issue: {
          number: 42,
          source: {
            provider: 'azure_devops',
            kind: 'work_item',
            id: '100',
            url: 'https://dev.azure.com/org/proj/_workitems/edit/100',
            title: 'Work item',
            mode: 'create',
            hierarchy: {
              parent: { id: '50', title: 'Epic', url: 'https://dev.azure.com/org/proj/_workitems/edit/50' },
              children: [{ id: '101', title: 'Child', url: 'https://dev.azure.com/org/proj/_workitems/edit/101' }],
              fetched_at: '2026-02-06T00:00:00.000Z',
            },
          },
        },
      };
      const result = readIssueSource(issueJson);
      expect(result).not.toBeNull();
      expect(result!.hierarchy).toBeDefined();
      expect(result!.hierarchy!.parent).not.toBeNull();
      expect(result!.hierarchy!.parent!.id).toBe('50');
      expect(result!.hierarchy!.children).toHaveLength(1);
    });

    it('derives source from legacy issue.number/url/title', () => {
      const issueJson: Record<string, unknown> = {
        issue: {
          number: 42,
          url: 'https://github.com/owner/repo/issues/42',
          title: 'Legacy issue',
        },
      };
      const result = readIssueSource(issueJson);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('github');
      expect(result!.kind).toBe('issue');
      expect(result!.id).toBe('42');
      expect(result!.url).toBe('https://github.com/owner/repo/issues/42');
      expect(result!.title).toBe('Legacy issue');
      expect(result!.mode).toBe('init_existing');
    });

    it('derives source from legacy with only number', () => {
      const issueJson: Record<string, unknown> = {
        issue: { number: 5 },
      };
      const result = readIssueSource(issueJson);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('5');
      expect(result!.url).toBeNull();
      expect(result!.title).toBe('');
    });

    it('returns null when no issue object', () => {
      expect(readIssueSource({})).toBeNull();
      expect(readIssueSource({ issue: 'not-an-object' })).toBeNull();
    });

    it('returns null when issue.number is invalid', () => {
      expect(readIssueSource({ issue: { number: 0 } })).toBeNull();
      expect(readIssueSource({ issue: { number: -1 } })).toBeNull();
      expect(readIssueSource({ issue: {} })).toBeNull();
    });

    it('applies defaults for missing source fields', () => {
      const issueJson: Record<string, unknown> = {
        issue: {
          number: 10,
          source: {
            id: '10',
          },
        },
      };
      const result = readIssueSource(issueJson);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('github');
      expect(result!.kind).toBe('issue');
      expect(result!.mode).toBe('init_existing');
    });

    it('falls back to legacy when explicit source is invalid', () => {
      const issueJson: Record<string, unknown> = {
        issue: {
          number: 10,
          url: 'https://github.com/o/r/issues/10',
          source: {
            provider: 'invalid_provider',
            id: '10',
          },
        },
      };
      const result = readIssueSource(issueJson);
      // Falls back to legacy because the explicit source has invalid provider
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('github');
      expect(result!.id).toBe('10');
    });
  });

  // ==========================================================================
  // Read: readIssueIngestStatus
  // ==========================================================================

  describe('readIssueIngestStatus', () => {
    it('returns ingest status when present', () => {
      const issueJson: Record<string, unknown> = {
        status: {
          issueIngest: {
            provider: 'azure_devops',
            mode: 'create',
            outcome: 'success',
            remote_id: '100',
            remote_url: 'https://dev.azure.com/org/proj/_workitems/edit/100',
            warnings: ['Warning 1'],
            auto_select_ok: true,
            auto_run_ok: false,
            occurred_at: '2026-02-06T00:00:00.000Z',
          },
        },
      };
      const result = readIssueIngestStatus(issueJson);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('azure_devops');
      expect(result!.outcome).toBe('success');
      expect(result!.warnings).toEqual(['Warning 1']);
    });

    it('returns null when no status', () => {
      expect(readIssueIngestStatus({})).toBeNull();
    });

    it('returns null when no issueIngest', () => {
      expect(readIssueIngestStatus({ status: {} })).toBeNull();
    });

    it('returns null when issueIngest has invalid data', () => {
      expect(readIssueIngestStatus({ status: { issueIngest: { provider: 'invalid' } } })).toBeNull();
    });

    it('applies defaults for missing optional fields', () => {
      const issueJson: Record<string, unknown> = {
        status: {
          issueIngest: {
            provider: 'github',
            mode: 'init_existing',
            outcome: 'success',
          },
        },
      };
      const result = readIssueIngestStatus(issueJson);
      expect(result).not.toBeNull();
      expect(result!.remote_id).toBeNull();
      expect(result!.remote_url).toBeNull();
      expect(result!.warnings).toEqual([]);
      expect(result!.auto_select_ok).toBeNull();
      expect(result!.auto_run_ok).toBeNull();
      expect(result!.occurred_at).toBeNull();
    });
  });

  // ==========================================================================
  // Read: readPullRequestMetadata
  // ==========================================================================

  describe('readPullRequestMetadata', () => {
    it('returns PR metadata with provider-aware fields', () => {
      const issueJson: Record<string, unknown> = {
        branch: 'issue/42',
        pullRequest: {
          provider: 'github',
          external_id: '99',
          source_branch: 'issue/42',
          target_branch: 'main',
          updated_at: '2026-02-06T00:00:00.000Z',
          number: 99,
          url: 'https://github.com/o/r/pull/99',
        },
      };
      const result = readPullRequestMetadata(issueJson);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('github');
      expect(result!.external_id).toBe('99');
      expect(result!.source_branch).toBe('issue/42');
      expect(result!.number).toBe(99);
    });

    it('returns PR metadata for azure_devops provider', () => {
      const issueJson: Record<string, unknown> = {
        pullRequest: {
          provider: 'azure_devops',
          external_id: '200',
          source_branch: 'issue/42',
          target_branch: 'main',
          updated_at: null,
        },
      };
      const result = readPullRequestMetadata(issueJson);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('azure_devops');
      expect(result!.external_id).toBe('200');
    });

    it('derives metadata from legacy pullRequest.number/url', () => {
      const issueJson: Record<string, unknown> = {
        branch: 'issue/42',
        issue: { number: 42 },
        pullRequest: {
          number: 55,
          url: 'https://github.com/o/r/pull/55',
        },
      };
      const result = readPullRequestMetadata(issueJson);
      expect(result).not.toBeNull();
      expect(result!.provider).toBe('github');
      expect(result!.external_id).toBe('55');
      expect(result!.source_branch).toBe('issue/42');
      expect(result!.target_branch).toBe('main');
      expect(result!.number).toBe(55);
    });

    it('returns null when no pullRequest', () => {
      expect(readPullRequestMetadata({})).toBeNull();
    });

    it('returns null when pullRequest is not an object', () => {
      expect(readPullRequestMetadata({ pullRequest: 'string' })).toBeNull();
      expect(readPullRequestMetadata({ pullRequest: [1, 2] })).toBeNull();
    });

    it('returns null when legacy number is invalid', () => {
      expect(readPullRequestMetadata({ pullRequest: { number: 0 } })).toBeNull();
      expect(readPullRequestMetadata({ pullRequest: { number: -1 } })).toBeNull();
    });

    it('uses branchName fallback for legacy source_branch', () => {
      const issueJson: Record<string, unknown> = {
        branchName: 'feature/legacy',
        pullRequest: {
          number: 10,
          url: 'https://github.com/o/r/pull/10',
        },
      };
      const result = readPullRequestMetadata(issueJson);
      expect(result).not.toBeNull();
      expect(result!.source_branch).toBe('feature/legacy');
    });
  });

  // ==========================================================================
  // Write: writeIssueSource
  // ==========================================================================

  describe('writeIssueSource', () => {
    it('writes source and syncs legacy fields', async () => {
      await writeRawIssueJson({ issue: { number: 1 }, notes: '' });

      await writeIssueSource(tempDir, VALID_SOURCE);

      const raw = await readRawIssueJson();
      const issue = raw.issue as Record<string, unknown>;
      expect(issue.source).toBeDefined();
      const source = issue.source as Record<string, unknown>;
      expect(source.provider).toBe('github');
      expect(source.id).toBe('42');

      // Legacy compat
      expect(issue.number).toBe(42);
      expect(issue.url).toBe('https://github.com/owner/repo/issues/42');
      expect(issue.title).toBe('Test issue');
    });

    it('writes source with hierarchy', async () => {
      await writeRawIssueJson({ issue: { number: 1 }, notes: '' });

      const sourceWithHierarchy: IssueSource = {
        ...VALID_SOURCE,
        hierarchy: {
          parent: { id: '1', title: 'Parent', url: 'https://example.com/1' },
          children: [{ id: '2', title: 'Child', url: 'https://example.com/2' }],
          fetched_at: '2026-02-06T00:00:00.000Z',
        },
      };
      await writeIssueSource(tempDir, sourceWithHierarchy);

      const raw = await readRawIssueJson();
      const source = (raw.issue as Record<string, unknown>).source as Record<string, unknown>;
      expect(source.hierarchy).toBeDefined();
    });

    it('preserves existing issue.json fields', async () => {
      await writeRawIssueJson({
        schemaVersion: 1,
        repo: 'owner/repo',
        issue: { number: 1, repo: 'owner/repo' },
        branch: 'issue/1',
        phase: 'design_classify',
        notes: 'my notes',
      });

      await writeIssueSource(tempDir, VALID_SOURCE);

      const raw = await readRawIssueJson();
      expect(raw.schemaVersion).toBe(1);
      expect(raw.repo).toBe('owner/repo');
      expect(raw.branch).toBe('issue/1');
      expect(raw.notes).toBe('my notes');
    });

    it('creates issue object if missing', async () => {
      await writeRawIssueJson({ notes: '' });

      await writeIssueSource(tempDir, VALID_SOURCE);

      const raw = await readRawIssueJson();
      const issue = raw.issue as Record<string, unknown>;
      expect(issue.source).toBeDefined();
      expect(issue.number).toBe(42);
    });

    it('creates issue.json if missing', async () => {
      await writeIssueSource(tempDir, VALID_SOURCE);

      const raw = await readRawIssueJson();
      expect(raw.issue).toBeDefined();
    });

    it('throws on invalid source', async () => {
      await writeRawIssueJson({ issue: { number: 1 } });

      await expect(
        writeIssueSource(tempDir, { ...VALID_SOURCE, id: '0' }),
      ).rejects.toThrow('Invalid IssueSource');
    });

    it('does not sync url when source url is null', async () => {
      await writeRawIssueJson({ issue: { number: 1, url: 'https://old.com' } });

      await writeIssueSource(tempDir, { ...VALID_SOURCE, url: null });

      const raw = await readRawIssueJson();
      const issue = raw.issue as Record<string, unknown>;
      // url should not be overwritten when source url is null
      expect(issue.url).toBe('https://old.com');
    });
  });

  // ==========================================================================
  // Write: writeIssueIngestStatus
  // ==========================================================================

  describe('writeIssueIngestStatus', () => {
    it('writes ingest status', async () => {
      await writeRawIssueJson({ issue: { number: 1 }, notes: '' });

      await writeIssueIngestStatus(tempDir, VALID_INGEST);

      const raw = await readRawIssueJson();
      const status = raw.status as Record<string, unknown>;
      expect(status.issueIngest).toBeDefined();
      const ingest = status.issueIngest as Record<string, unknown>;
      expect(ingest.provider).toBe('azure_devops');
      expect(ingest.outcome).toBe('success');
      expect(ingest.remote_id).toBe('100');
    });

    it('preserves existing status fields', async () => {
      await writeRawIssueJson({
        issue: { number: 1 },
        status: { sonarToken: { sync_status: 'in_sync' }, prCreated: false },
      });

      await writeIssueIngestStatus(tempDir, VALID_INGEST);

      const raw = await readRawIssueJson();
      const status = raw.status as Record<string, unknown>;
      expect(status.sonarToken).toEqual({ sync_status: 'in_sync' });
      expect(status.prCreated).toBe(false);
      expect(status.issueIngest).toBeDefined();
    });

    it('creates status object if missing', async () => {
      await writeRawIssueJson({ issue: { number: 1 } });

      await writeIssueIngestStatus(tempDir, VALID_INGEST);

      const raw = await readRawIssueJson();
      expect(raw.status).toBeDefined();
    });

    it('throws on invalid ingest status', async () => {
      await writeRawIssueJson({ issue: { number: 1 } });

      await expect(
        writeIssueIngestStatus(tempDir, { ...VALID_INGEST, outcome: 'timeout' as never }),
      ).rejects.toThrow('Invalid IssueIngestStatus');
    });

    it('writes error outcome', async () => {
      await writeRawIssueJson({ issue: { number: 1 } });

      const errorIngest: IssueIngestStatus = {
        ...VALID_INGEST,
        outcome: 'error',
        remote_id: null,
        remote_url: null,
      };
      await writeIssueIngestStatus(tempDir, errorIngest);

      const raw = await readRawIssueJson();
      const ingest = (raw.status as Record<string, unknown>).issueIngest as Record<string, unknown>;
      expect(ingest.outcome).toBe('error');
      expect(ingest.remote_id).toBeNull();
    });
  });

  // ==========================================================================
  // Write: writePullRequestMetadata
  // ==========================================================================

  describe('writePullRequestMetadata', () => {
    it('writes PR metadata and sets prCreated', async () => {
      await writeRawIssueJson({ issue: { number: 42 }, notes: '' });

      await writePullRequestMetadata(tempDir, VALID_PR);

      const raw = await readRawIssueJson();
      const pr = raw.pullRequest as Record<string, unknown>;
      expect(pr.provider).toBe('github');
      expect(pr.external_id).toBe('99');
      expect(pr.source_branch).toBe('issue/42');
      expect(pr.target_branch).toBe('main');
      expect(pr.number).toBe(99);

      // prCreated should be set
      const status = raw.status as Record<string, unknown>;
      expect(status.prCreated).toBe(true);
    });

    it('sets prCreated for azure_devops provider', async () => {
      await writeRawIssueJson({ issue: { number: 42 } });

      const azurePr: PullRequestMetadata = {
        provider: 'azure_devops',
        external_id: '200',
        source_branch: 'issue/42',
        target_branch: 'main',
        updated_at: '2026-02-06T00:00:00.000Z',
      };
      await writePullRequestMetadata(tempDir, azurePr);

      const raw = await readRawIssueJson();
      const status = raw.status as Record<string, unknown>;
      expect(status.prCreated).toBe(true);
      expect((raw.pullRequest as Record<string, unknown>).provider).toBe('azure_devops');
    });

    it('preserves existing issue.json fields', async () => {
      await writeRawIssueJson({
        issue: { number: 42 },
        branch: 'issue/42',
        notes: 'my notes',
        status: { sonarToken: { sync_status: 'in_sync' } },
      });

      await writePullRequestMetadata(tempDir, VALID_PR);

      const raw = await readRawIssueJson();
      expect(raw.branch).toBe('issue/42');
      expect(raw.notes).toBe('my notes');
      const status = raw.status as Record<string, unknown>;
      expect(status.sonarToken).toEqual({ sync_status: 'in_sync' });
      expect(status.prCreated).toBe(true);
    });

    it('does not set prCreated if validation fails', async () => {
      await writeRawIssueJson({ issue: { number: 42 }, status: { prCreated: false } });

      await expect(
        writePullRequestMetadata(tempDir, { ...VALID_PR, external_id: '0' }),
      ).rejects.toThrow('Invalid PullRequestMetadata');

      const raw = await readRawIssueJson();
      const status = raw.status as Record<string, unknown>;
      expect(status.prCreated).toBe(false);
    });

    it('throws on invalid PR metadata', async () => {
      await writeRawIssueJson({ issue: { number: 42 } });

      await expect(
        writePullRequestMetadata(tempDir, { ...VALID_PR, source_branch: '' }),
      ).rejects.toThrow('Invalid PullRequestMetadata');
    });

    it('creates status object if missing', async () => {
      await writeRawIssueJson({ issue: { number: 42 } });

      await writePullRequestMetadata(tempDir, VALID_PR);

      const raw = await readRawIssueJson();
      expect(raw.status).toBeDefined();
      expect((raw.status as Record<string, unknown>).prCreated).toBe(true);
    });

    it('overwrites previous PR metadata', async () => {
      await writeRawIssueJson({
        issue: { number: 42 },
        pullRequest: { number: 10, url: 'https://github.com/o/r/pull/10' },
      });

      await writePullRequestMetadata(tempDir, VALID_PR);

      const raw = await readRawIssueJson();
      const pr = raw.pullRequest as Record<string, unknown>;
      expect(pr.number).toBe(99);
      expect(pr.external_id).toBe('99');
    });
  });

  // ==========================================================================
  // Legacy compatibility: round-trip
  // ==========================================================================

  describe('legacy compatibility', () => {
    it('readIssueSource works with a minimal legacy issue.json', () => {
      const legacyJson: Record<string, unknown> = {
        schemaVersion: 1,
        repo: 'owner/repo',
        issue: { number: 10, repo: 'owner/repo', title: 'My issue' },
        branch: 'issue/10',
        phase: 'design_classify',
        workflow: 'default',
        notes: '',
      };
      const source = readIssueSource(legacyJson);
      expect(source).not.toBeNull();
      expect(source!.provider).toBe('github');
      expect(source!.kind).toBe('issue');
      expect(source!.id).toBe('10');
      expect(source!.title).toBe('My issue');
    });

    it('readIssueIngestStatus returns null for legacy issue.json without ingest', () => {
      const legacyJson: Record<string, unknown> = {
        issue: { number: 10 },
        status: { sonarToken: { sync_status: 'in_sync' } },
      };
      expect(readIssueIngestStatus(legacyJson)).toBeNull();
    });

    it('readPullRequestMetadata derives from legacy number+url', () => {
      const legacyJson: Record<string, unknown> = {
        issue: { number: 10 },
        branch: 'issue/10',
        pullRequest: {
          number: 20,
          url: 'https://github.com/o/r/pull/20',
        },
      };
      const pr = readPullRequestMetadata(legacyJson);
      expect(pr).not.toBeNull();
      expect(pr!.provider).toBe('github');
      expect(pr!.external_id).toBe('20');
      expect(pr!.source_branch).toBe('issue/10');
      expect(pr!.target_branch).toBe('main');
    });

    it('write then read round-trips correctly', async () => {
      await writeRawIssueJson({
        schemaVersion: 1,
        repo: 'owner/repo',
        issue: { number: 1, repo: 'owner/repo' },
        branch: 'issue/1',
        notes: '',
      });

      // Write source
      await writeIssueSource(tempDir, VALID_SOURCE);
      const sourceRead = readIssueSource(await readRawIssueJson());
      expect(sourceRead).not.toBeNull();
      expect(sourceRead!.provider).toBe(VALID_SOURCE.provider);
      expect(sourceRead!.id).toBe(VALID_SOURCE.id);

      // Write ingest
      await writeIssueIngestStatus(tempDir, VALID_INGEST);
      const ingestRead = readIssueIngestStatus(await readRawIssueJson());
      expect(ingestRead).not.toBeNull();
      expect(ingestRead!.provider).toBe(VALID_INGEST.provider);
      expect(ingestRead!.outcome).toBe(VALID_INGEST.outcome);

      // Write PR
      await writePullRequestMetadata(tempDir, VALID_PR);
      const prRead = readPullRequestMetadata(await readRawIssueJson());
      expect(prRead).not.toBeNull();
      expect(prRead!.provider).toBe(VALID_PR.provider);
      expect(prRead!.external_id).toBe(VALID_PR.external_id);

      // Verify all three are present together
      const final = await readRawIssueJson();
      expect((final.issue as Record<string, unknown>).source).toBeDefined();
      expect((final.status as Record<string, unknown>).issueIngest).toBeDefined();
      expect((final.status as Record<string, unknown>).prCreated).toBe(true);
      expect(final.pullRequest).toBeDefined();
    });
  });
});
