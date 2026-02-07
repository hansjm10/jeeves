import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireLock,
  cleanupStaleArtifacts,
  createJournal,
  DEFAULT_LOCK_TIMEOUT_MS,
  deleteJournal,
  deleteOpsArtifacts,
  detectRecovery,
  finalizeJournal,
  generateOperationId,
  getJournalPath,
  getLockPath,
  getOpsDir,
  ISSUE_REF_PATTERN,
  isLockStale,
  MAX_REMOTE_URL_LENGTH,
  MAX_WARNING_LENGTH,
  MAX_WARNINGS,
  OPERATION_ID_PATTERN,
  POSITIVE_INTEGER_STRING_PATTERN,
  readJournal,
  readLock,
  refreshLock,
  releaseLock,
  STATE_PATTERN,
  updateJournalCheckpoint,
  updateJournalState,
} from './providerOperationJournal.js';

import type {
  ProviderOperationLock,
} from './providerOperationJournal.js';

describe('providerOperationJournal', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-ops-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => void 0);
  });

  // --------------------------------------------------------------------------
  // Path Helpers
  // --------------------------------------------------------------------------

  describe('path helpers', () => {
    it('getOpsDir returns correct path', () => {
      expect(getOpsDir('/some/dir')).toBe('/some/dir/.ops');
    });

    it('getJournalPath returns correct path', () => {
      expect(getJournalPath('/some/dir')).toBe('/some/dir/.ops/provider-operation.json');
    });

    it('getLockPath returns correct path', () => {
      expect(getLockPath('/some/dir')).toBe('/some/dir/.ops/provider-operation.lock');
    });
  });

  // --------------------------------------------------------------------------
  // Constants / Patterns
  // --------------------------------------------------------------------------

  describe('constants', () => {
    it('OPERATION_ID_PATTERN accepts valid IDs', () => {
      expect(OPERATION_ID_PATTERN.test('abc12345')).toBe(true);
      expect(OPERATION_ID_PATTERN.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
      expect(OPERATION_ID_PATTERN.test('op.test:id-1')).toBe(true);
    });

    it('OPERATION_ID_PATTERN rejects invalid IDs', () => {
      expect(OPERATION_ID_PATTERN.test('short')).toBe(false); // too short
      expect(OPERATION_ID_PATTERN.test('')).toBe(false);
      expect(OPERATION_ID_PATTERN.test('has space')).toBe(false);
      expect(OPERATION_ID_PATTERN.test('a'.repeat(129))).toBe(false); // too long
    });

    it('STATE_PATTERN accepts valid states', () => {
      expect(STATE_PATTERN.test('cred.validating')).toBe(true);
      expect(STATE_PATTERN.test('ingest.persisting_issue_state')).toBe(true);
      expect(STATE_PATTERN.test('pr.checking_existing')).toBe(true);
    });

    it('STATE_PATTERN rejects invalid states', () => {
      expect(STATE_PATTERN.test('invalid.State')).toBe(false); // uppercase
      expect(STATE_PATTERN.test('other.validating')).toBe(false); // wrong prefix
      expect(STATE_PATTERN.test('cred')).toBe(false); // no dot
    });

    it('ISSUE_REF_PATTERN accepts valid refs', () => {
      expect(ISSUE_REF_PATTERN.test('owner/repo#123')).toBe(true);
      expect(ISSUE_REF_PATTERN.test('my-org/my-repo#1')).toBe(true);
    });

    it('ISSUE_REF_PATTERN rejects invalid refs', () => {
      expect(ISSUE_REF_PATTERN.test('owner/repo')).toBe(false);
      expect(ISSUE_REF_PATTERN.test('owner/repo#')).toBe(false);
      expect(ISSUE_REF_PATTERN.test('repo#123')).toBe(false);
      expect(ISSUE_REF_PATTERN.test('')).toBe(false);
    });

    it('DEFAULT_LOCK_TIMEOUT_MS is 30 seconds', () => {
      expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(30_000);
    });

    it('MAX_WARNINGS is 50', () => {
      expect(MAX_WARNINGS).toBe(50);
    });

    it('MAX_WARNING_LENGTH is 512', () => {
      expect(MAX_WARNING_LENGTH).toBe(512);
    });

    it('POSITIVE_INTEGER_STRING_PATTERN accepts valid positive integers', () => {
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('1')).toBe(true);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('12345')).toBe(true);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('999999999999999999')).toBe(true);
    });

    it('POSITIVE_INTEGER_STRING_PATTERN rejects invalid values', () => {
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('0')).toBe(false);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('01')).toBe(false);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('-1')).toBe(false);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('')).toBe(false);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('abc')).toBe(false);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('12.34')).toBe(false);
      expect(POSITIVE_INTEGER_STRING_PATTERN.test('1'.repeat(20))).toBe(false); // too long
    });

    it('MAX_REMOTE_URL_LENGTH is 2048', () => {
      expect(MAX_REMOTE_URL_LENGTH).toBe(2048);
    });
  });

  // --------------------------------------------------------------------------
  // generateOperationId
  // --------------------------------------------------------------------------

  describe('generateOperationId', () => {
    it('returns a string matching OPERATION_ID_PATTERN', () => {
      const id = generateOperationId();
      expect(OPERATION_ID_PATTERN.test(id)).toBe(true);
    });

    it('returns unique values on successive calls', () => {
      const ids = new Set(Array.from({ length: 10 }, () => generateOperationId()));
      expect(ids.size).toBe(10);
    });
  });

  // --------------------------------------------------------------------------
  // acquireLock
  // --------------------------------------------------------------------------

  describe('acquireLock', () => {
    const validParams = {
      operation_id: 'test-op-12345678',
      issue_ref: 'owner/repo#42',
    };

    it('creates .ops dir if absent', async () => {
      const result = await acquireLock(tempDir, validParams);
      expect(result.acquired).toBe(true);

      const opsDir = getOpsDir(tempDir);
      const stat = await fs.stat(opsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('writes valid lock file with correct schema', async () => {
      await acquireLock(tempDir, validParams);

      const lock = await readLock(tempDir);
      expect(lock).not.toBeNull();
      expect(lock!.schemaVersion).toBe(1);
      expect(lock!.operation_id).toBe(validParams.operation_id);
      expect(lock!.issue_ref).toBe(validParams.issue_ref);
      expect(lock!.pid).toBe(process.pid);
      expect(typeof lock!.acquired_at).toBe('string');
      expect(typeof lock!.expires_at).toBe('string');
    });

    it('returns acquired: true on first call', async () => {
      const result = await acquireLock(tempDir, validParams);
      expect(result).toEqual({ acquired: true, operation_id: validParams.operation_id });
    });

    it('returns acquired: false reason: busy when lock held by live process', async () => {
      await acquireLock(tempDir, validParams);
      const result = await acquireLock(tempDir, {
        operation_id: 'another-op-1234',
        issue_ref: 'owner/repo#42',
      });
      expect(result).toEqual({ acquired: false, reason: 'busy' });
    });

    it('returns acquired: false reason: stale_cleaned when lock expired', async () => {
      // Write a lock with past expires_at
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const staleLock: ProviderOperationLock = {
        schemaVersion: 1,
        operation_id: 'stale-op-12345678',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(), // expired 60s ago
        pid: process.pid,
      };
      await fs.writeFile(getLockPath(tempDir), JSON.stringify(staleLock, null, 2) + '\n', 'utf-8');

      const result = await acquireLock(tempDir, validParams);
      expect(result).toEqual({ acquired: false, reason: 'stale_cleaned' });

      // Lock file should be removed
      const lockAfter = await readLock(tempDir);
      expect(lockAfter).toBeNull();
    });

    it('returns acquired: false reason: stale_cleaned when lock PID is dead', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const deadPidLock: ProviderOperationLock = {
        schemaVersion: 1,
        operation_id: 'dead-pid-op-1234',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(), // not expired
        pid: 999999999, // very unlikely to be alive
      };
      await fs.writeFile(getLockPath(tempDir), JSON.stringify(deadPidLock, null, 2) + '\n', 'utf-8');

      const result = await acquireLock(tempDir, validParams);
      expect(result).toEqual({ acquired: false, reason: 'stale_cleaned' });
    });

    it('lock file has correct permissions (0600) on POSIX', async () => {
      // Skip on Windows
      if (process.platform === 'win32') return;

      await acquireLock(tempDir, validParams);
      const stat = await fs.stat(getLockPath(tempDir));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('validates operation_id against pattern', async () => {
      await expect(
        acquireLock(tempDir, { operation_id: 'short', issue_ref: 'owner/repo#1' }),
      ).rejects.toThrow('Invalid operation_id');
    });

    it('validates issue_ref against pattern', async () => {
      await expect(
        acquireLock(tempDir, { operation_id: 'valid-op-12345678', issue_ref: 'invalid' }),
      ).rejects.toThrow('Invalid issue_ref');
    });

    it('sets expires_at based on timeout_ms', async () => {
      const before = Date.now();
      await acquireLock(tempDir, { ...validParams, timeout_ms: 60_000 });
      const lock = await readLock(tempDir);
      const expiresAt = new Date(lock!.expires_at).getTime();
      // Should be approximately 60s in the future
      expect(expiresAt).toBeGreaterThanOrEqual(before + 59_000);
      expect(expiresAt).toBeLessThanOrEqual(before + 62_000);
    });
  });

  // --------------------------------------------------------------------------
  // releaseLock
  // --------------------------------------------------------------------------

  describe('releaseLock', () => {
    it('removes lock file', async () => {
      await acquireLock(tempDir, {
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
      });
      expect(await readLock(tempDir)).not.toBeNull();

      await releaseLock(tempDir);
      expect(await readLock(tempDir)).toBeNull();
    });

    it('idempotent when no lock file', async () => {
      // Should not throw
      await releaseLock(tempDir);
    });
  });

  // --------------------------------------------------------------------------
  // refreshLock
  // --------------------------------------------------------------------------

  describe('refreshLock', () => {
    it('updates expires_at', async () => {
      await acquireLock(tempDir, {
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
        timeout_ms: 10_000,
      });
      const before = await readLock(tempDir);

      // Wait briefly to get a different timestamp
      await new Promise((r) => setTimeout(r, 10));

      const refreshed = await refreshLock(tempDir, { timeout_ms: 60_000 });
      expect(refreshed).toBe(true);

      const after = await readLock(tempDir);
      expect(new Date(after!.expires_at).getTime()).toBeGreaterThan(
        new Date(before!.expires_at).getTime(),
      );
    });

    it('returns false when no lock', async () => {
      const result = await refreshLock(tempDir);
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // isLockStale
  // --------------------------------------------------------------------------

  describe('isLockStale', () => {
    it('returns true when expired', () => {
      const lock: ProviderOperationLock = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        pid: process.pid,
      };
      expect(isLockStale(lock)).toBe(true);
    });

    it('returns true when PID dead', () => {
      const lock: ProviderOperationLock = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        pid: 999999999,
      };
      expect(isLockStale(lock)).toBe(true);
    });

    it('returns false when active and not expired', () => {
      const lock: ProviderOperationLock = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        pid: process.pid,
      };
      expect(isLockStale(lock)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // createJournal
  // --------------------------------------------------------------------------

  describe('createJournal', () => {
    const validParams = {
      operation_id: 'test-op-12345678',
      kind: 'credentials' as const,
      state: 'cred.validating',
      issue_ref: 'owner/repo#42',
      provider: 'azure_devops' as const,
    };

    it('writes valid journal with all required fields', async () => {
      const journal = await createJournal(tempDir, validParams);

      expect(journal.schemaVersion).toBe(1);
      expect(journal.operation_id).toBe(validParams.operation_id);
      expect(journal.kind).toBe('credentials');
      expect(journal.state).toBe('cred.validating');
      expect(journal.issue_ref).toBe('owner/repo#42');
      expect(journal.provider).toBe('azure_devops');
      expect(typeof journal.started_at).toBe('string');
      expect(typeof journal.updated_at).toBe('string');
    });

    it('sets completed_at to null', async () => {
      const journal = await createJournal(tempDir, validParams);
      expect(journal.completed_at).toBeNull();
    });

    it('initializes checkpoint with defaults', async () => {
      const journal = await createJournal(tempDir, validParams);
      expect(journal.checkpoint).toEqual({
        remote_id: null,
        remote_url: null,
        pr_id: null,
        issue_state_persisted: false,
        init_completed: false,
        auto_selected: false,
        auto_run_started: false,
        warnings: [],
      });
    });

    it('validates kind against enum', async () => {
      await expect(
        createJournal(tempDir, { ...validParams, kind: 'invalid' as 'credentials' }),
      ).rejects.toThrow('Invalid kind');
    });

    it('validates state against pattern', async () => {
      await expect(
        createJournal(tempDir, { ...validParams, state: 'invalid' }),
      ).rejects.toThrow('Invalid state');
    });

    it('validates operation_id against pattern', async () => {
      await expect(
        createJournal(tempDir, { ...validParams, operation_id: 'short' }),
      ).rejects.toThrow('Invalid operation_id');
    });

    it('validates issue_ref against pattern', async () => {
      await expect(
        createJournal(tempDir, { ...validParams, issue_ref: 'bad' }),
      ).rejects.toThrow('Invalid issue_ref');
    });

    it('validates provider against enum', async () => {
      await expect(
        createJournal(tempDir, { ...validParams, provider: 'invalid' as 'github' }),
      ).rejects.toThrow('Invalid provider');
    });

    it('accepts null provider', async () => {
      const journal = await createJournal(tempDir, { ...validParams, provider: null });
      expect(journal.provider).toBeNull();
    });

    it('creates .ops dir if absent', async () => {
      await createJournal(tempDir, validParams);
      const stat = await fs.stat(getOpsDir(tempDir));
      expect(stat.isDirectory()).toBe(true);
    });

    it('journal file has correct permissions (0600) on POSIX', async () => {
      if (process.platform === 'win32') return;

      await createJournal(tempDir, validParams);
      const stat = await fs.stat(getJournalPath(tempDir));
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  // --------------------------------------------------------------------------
  // updateJournalState
  // --------------------------------------------------------------------------

  describe('updateJournalState', () => {
    it('updates state and updated_at', async () => {
      const journal = await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });

      await new Promise((r) => setTimeout(r, 10));
      const updated = await updateJournalState(tempDir, 'cred.persisting_secret');

      expect(updated.state).toBe('cred.persisting_secret');
      expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
        new Date(journal.updated_at).getTime(),
      );
    });

    it('preserves other fields', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });

      const updated = await updateJournalState(tempDir, 'ingest.creating_remote');
      expect(updated.operation_id).toBe('test-op-12345678');
      expect(updated.kind).toBe('ingest');
      expect(updated.issue_ref).toBe('owner/repo#42');
      expect(updated.provider).toBe('github');
      expect(updated.completed_at).toBeNull();
    });

    it('throws when no journal exists', async () => {
      await expect(updateJournalState(tempDir, 'cred.validating')).rejects.toThrow(
        'No journal file exists',
      );
    });

    it('validates state pattern', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });

      await expect(updateJournalState(tempDir, 'INVALID')).rejects.toThrow('Invalid state');
    });
  });

  // --------------------------------------------------------------------------
  // updateJournalCheckpoint
  // --------------------------------------------------------------------------

  describe('updateJournalCheckpoint', () => {
    beforeEach(async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });
    });

    it('merges checkpoint fields', async () => {
      const updated = await updateJournalCheckpoint(tempDir, {
        remote_id: '12345',
        remote_url: 'https://github.com/owner/repo/issues/42',
      });

      expect(updated.checkpoint.remote_id).toBe('12345');
      expect(updated.checkpoint.remote_url).toBe('https://github.com/owner/repo/issues/42');
      // Other fields should remain at defaults
      expect(updated.checkpoint.pr_id).toBeNull();
      expect(updated.checkpoint.issue_state_persisted).toBe(false);
    });

    it('preserves existing checkpoint fields not in update', async () => {
      await updateJournalCheckpoint(tempDir, { remote_id: '12345' });
      const updated = await updateJournalCheckpoint(tempDir, { issue_state_persisted: true });

      expect(updated.checkpoint.remote_id).toBe('12345');
      expect(updated.checkpoint.issue_state_persisted).toBe(true);
    });

    it('truncates warnings to MAX_WARNINGS', async () => {
      const manyWarnings = Array.from({ length: 60 }, (_, i) => `warning ${i}`);
      const updated = await updateJournalCheckpoint(tempDir, { warnings: manyWarnings });
      expect(updated.checkpoint.warnings).toHaveLength(MAX_WARNINGS);
    });

    it('truncates individual warnings to MAX_WARNING_LENGTH', async () => {
      const longWarning = 'x'.repeat(1000);
      const updated = await updateJournalCheckpoint(tempDir, { warnings: [longWarning] });
      expect(updated.checkpoint.warnings[0]).toHaveLength(MAX_WARNING_LENGTH);
    });

    // ---------- checkpoint field validation ----------

    it('accepts valid remote_id (positive-integer string)', async () => {
      const updated = await updateJournalCheckpoint(tempDir, { remote_id: '1' });
      expect(updated.checkpoint.remote_id).toBe('1');
    });

    it('accepts valid remote_id with many digits', async () => {
      const updated = await updateJournalCheckpoint(tempDir, { remote_id: '123456789012345678' });
      expect(updated.checkpoint.remote_id).toBe('123456789012345678');
    });

    it('accepts null remote_id', async () => {
      const updated = await updateJournalCheckpoint(tempDir, { remote_id: null });
      expect(updated.checkpoint.remote_id).toBeNull();
    });

    it('rejects remote_id that is not a positive-integer string', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_id: 'abc' })).rejects.toThrow('Invalid remote_id');
    });

    it('rejects remote_id "0"', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_id: '0' })).rejects.toThrow('Invalid remote_id');
    });

    it('rejects remote_id "-1"', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_id: '-1' })).rejects.toThrow('Invalid remote_id');
    });

    it('rejects remote_id "01" (leading zero)', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_id: '01' })).rejects.toThrow('Invalid remote_id');
    });

    it('accepts valid remote_url (absolute https:// URL)', async () => {
      const updated = await updateJournalCheckpoint(tempDir, { remote_url: 'https://github.com/owner/repo/issues/42' });
      expect(updated.checkpoint.remote_url).toBe('https://github.com/owner/repo/issues/42');
    });

    it('accepts null remote_url', async () => {
      const updated = await updateJournalCheckpoint(tempDir, { remote_url: null });
      expect(updated.checkpoint.remote_url).toBeNull();
    });

    it('rejects remote_url with http:// (not https)', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_url: 'http://example.com' })).rejects.toThrow('Invalid remote_url');
    });

    it('rejects remote_url that is not a URL', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_url: 'not-a-url' })).rejects.toThrow('Invalid remote_url');
    });

    it('rejects remote_url with ftp://', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_url: 'ftp://example.com/file' })).rejects.toThrow('Invalid remote_url');
    });

    it('rejects remote_url that is just "https://" (no host)', async () => {
      await expect(updateJournalCheckpoint(tempDir, { remote_url: 'https://' })).rejects.toThrow('Invalid remote_url');
    });

    it('rejects remote_url exceeding MAX_REMOTE_URL_LENGTH', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(MAX_REMOTE_URL_LENGTH);
      await expect(updateJournalCheckpoint(tempDir, { remote_url: longUrl })).rejects.toThrow('Invalid remote_url');
    });

    it('accepts valid pr_id (positive-integer string)', async () => {
      const updated = await updateJournalCheckpoint(tempDir, { pr_id: '42' });
      expect(updated.checkpoint.pr_id).toBe('42');
    });

    it('accepts null pr_id', async () => {
      const updated = await updateJournalCheckpoint(tempDir, { pr_id: null });
      expect(updated.checkpoint.pr_id).toBeNull();
    });

    it('rejects pr_id that is not a positive-integer string', async () => {
      await expect(updateJournalCheckpoint(tempDir, { pr_id: 'abc' })).rejects.toThrow('Invalid pr_id');
    });

    it('rejects pr_id "0"', async () => {
      await expect(updateJournalCheckpoint(tempDir, { pr_id: '0' })).rejects.toThrow('Invalid pr_id');
    });

    it('throws when no journal exists', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-'));
      try {
        await expect(
          updateJournalCheckpoint(emptyDir, { remote_id: '1' }),
        ).rejects.toThrow('No journal file exists');
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => void 0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // finalizeJournal
  // --------------------------------------------------------------------------

  describe('finalizeJournal', () => {
    it('sets completed_at to ISO timestamp', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });

      const finalized = await finalizeJournal(tempDir, 'cred.done');
      expect(finalized.completed_at).not.toBeNull();
      expect(typeof finalized.completed_at).toBe('string');
      // Should be a valid ISO date
      expect(new Date(finalized.completed_at!).toISOString()).toBe(finalized.completed_at);
    });

    it('updates state to terminal state', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });

      const finalized = await finalizeJournal(tempDir, 'ingest.done');
      expect(finalized.state).toBe('ingest.done');
    });

    it('throws when no journal exists', async () => {
      await expect(finalizeJournal(tempDir, 'cred.done')).rejects.toThrow(
        'No journal file exists',
      );
    });

    it('validates state pattern', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });

      await expect(finalizeJournal(tempDir, 'INVALID')).rejects.toThrow('Invalid state');
    });
  });

  // --------------------------------------------------------------------------
  // readJournal
  // --------------------------------------------------------------------------

  describe('readJournal', () => {
    it('returns null when absent', async () => {
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns null when invalid JSON', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      await fs.writeFile(getJournalPath(tempDir), 'not-json{{{', 'utf-8');
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns null when wrong schema version', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const badJournal = {
        schemaVersion: 99,
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        checkpoint: {
          remote_id: null,
          remote_url: null,
          pr_id: null,
          issue_state_persisted: false,
          init_completed: false,
          auto_selected: false,
          auto_run_started: false,
          warnings: [],
        },
      };
      await fs.writeFile(getJournalPath(tempDir), JSON.stringify(badJournal), 'utf-8');
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns null when missing required fields', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      await fs.writeFile(getJournalPath(tempDir), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns valid journal when file is correct', async () => {
      const created = await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });

      const read = await readJournal(tempDir);
      expect(read).not.toBeNull();
      expect(read!.operation_id).toBe(created.operation_id);
      expect(read!.kind).toBe('credentials');
      expect(read!.provider).toBe('azure_devops');
    });

    // ---------- checkpoint field validation on read ----------

    it('returns null when checkpoint.remote_id is non-null but not a positive-integer string', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const badJournal = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        checkpoint: {
          remote_id: 'abc',
          remote_url: null,
          pr_id: null,
          issue_state_persisted: false,
          init_completed: false,
          auto_selected: false,
          auto_run_started: false,
          warnings: [],
        },
      };
      await fs.writeFile(getJournalPath(tempDir), JSON.stringify(badJournal), 'utf-8');
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns null when checkpoint.remote_url is non-null but not an https:// URL', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const badJournal = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        checkpoint: {
          remote_id: null,
          remote_url: 'http://example.com',
          pr_id: null,
          issue_state_persisted: false,
          init_completed: false,
          auto_selected: false,
          auto_run_started: false,
          warnings: [],
        },
      };
      await fs.writeFile(getJournalPath(tempDir), JSON.stringify(badJournal), 'utf-8');
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns null when checkpoint.pr_id is non-null but not a positive-integer string', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const badJournal = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        checkpoint: {
          remote_id: null,
          remote_url: null,
          pr_id: '0',
          issue_state_persisted: false,
          init_completed: false,
          auto_selected: false,
          auto_run_started: false,
          warnings: [],
        },
      };
      await fs.writeFile(getJournalPath(tempDir), JSON.stringify(badJournal), 'utf-8');
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns valid journal when checkpoint fields are null (defaults)', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const goodJournal = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        checkpoint: {
          remote_id: null,
          remote_url: null,
          pr_id: null,
          issue_state_persisted: false,
          init_completed: false,
          auto_selected: false,
          auto_run_started: false,
          warnings: [],
        },
      };
      await fs.writeFile(getJournalPath(tempDir), JSON.stringify(goodJournal), 'utf-8');
      expect(await readJournal(tempDir)).not.toBeNull();
    });

    it('returns valid journal when checkpoint fields have valid non-null values', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const goodJournal = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_at: null,
        checkpoint: {
          remote_id: '42',
          remote_url: 'https://github.com/owner/repo/issues/42',
          pr_id: '99',
          issue_state_persisted: true,
          init_completed: false,
          auto_selected: false,
          auto_run_started: false,
          warnings: [],
        },
      };
      await fs.writeFile(getJournalPath(tempDir), JSON.stringify(goodJournal), 'utf-8');
      const result = await readJournal(tempDir);
      expect(result).not.toBeNull();
      expect(result!.checkpoint.remote_id).toBe('42');
      expect(result!.checkpoint.remote_url).toBe('https://github.com/owner/repo/issues/42');
      expect(result!.checkpoint.pr_id).toBe('99');
    });
  });

  // --------------------------------------------------------------------------
  // readLock
  // --------------------------------------------------------------------------

  describe('readLock', () => {
    it('returns null when absent', async () => {
      expect(await readLock(tempDir)).toBeNull();
    });

    it('returns null when invalid JSON', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      await fs.writeFile(getLockPath(tempDir), '{bad-json', 'utf-8');
      expect(await readLock(tempDir)).toBeNull();
    });

    it('returns null when wrong schema version', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const badLock = {
        schemaVersion: 99,
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        pid: process.pid,
      };
      await fs.writeFile(getLockPath(tempDir), JSON.stringify(badLock), 'utf-8');
      expect(await readLock(tempDir)).toBeNull();
    });

    it('returns null when pid is invalid', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });
      const badLock = {
        schemaVersion: 1,
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        pid: 0, // invalid: must be >= 1
      };
      await fs.writeFile(getLockPath(tempDir), JSON.stringify(badLock), 'utf-8');
      expect(await readLock(tempDir)).toBeNull();
    });

    it('returns valid lock when file is correct', async () => {
      await acquireLock(tempDir, {
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
      });

      const lock = await readLock(tempDir);
      expect(lock).not.toBeNull();
      expect(lock!.operation_id).toBe('test-op-12345678');
    });
  });

  // --------------------------------------------------------------------------
  // deleteJournal / deleteOpsArtifacts
  // --------------------------------------------------------------------------

  describe('deleteJournal', () => {
    it('returns true when journal existed', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });

      const result = await deleteJournal(tempDir);
      expect(result).toBe(true);
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('returns false when journal does not exist', async () => {
      const result = await deleteJournal(tempDir);
      expect(result).toBe(false);
    });
  });

  describe('deleteOpsArtifacts', () => {
    it('removes both lock and journal files', async () => {
      await acquireLock(tempDir, {
        operation_id: 'test-op-12345678',
        issue_ref: 'owner/repo#42',
      });
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });

      await deleteOpsArtifacts(tempDir);
      expect(await readLock(tempDir)).toBeNull();
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('idempotent when files do not exist', async () => {
      // Should not throw
      await deleteOpsArtifacts(tempDir);
    });
  });

  // --------------------------------------------------------------------------
  // detectRecovery
  // --------------------------------------------------------------------------

  describe('detectRecovery', () => {
    it('returns needed: false when no journal', async () => {
      const result = await detectRecovery(tempDir);
      expect(result).toEqual({ needed: false });
    });

    it('returns needed: false when journal is completed', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });
      await finalizeJournal(tempDir, 'cred.done');

      const result = await detectRecovery(tempDir);
      expect(result).toEqual({ needed: false });
    });

    it('returns recovery_state = cred.reconciling_worktree for credential ops past persisting_secret', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.persisting_secret',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('cred.reconciling_worktree');
      }
    });

    it('returns recovery_state = cred.reconciling_worktree for credential ops at reconciling_worktree', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.reconciling_worktree',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('cred.reconciling_worktree');
      }
    });

    it('returns recovery_state = cred.validating for credential ops before persisting_secret', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('cred.validating');
      }
    });

    it('returns recovery_state = ingest.persisting_issue_state when remote_id known', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.creating_remote',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });
      await updateJournalCheckpoint(tempDir, { remote_id: '12345' });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('ingest.persisting_issue_state');
      }
    });

    it('returns recovery_state = ingest.recording_status when issue_state_persisted', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.persisting_issue_state',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });
      await updateJournalCheckpoint(tempDir, { issue_state_persisted: true });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('ingest.recording_status');
      }
    });

    it('returns recovery_state = ingest.validating when no checkpoint progress', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('ingest.validating');
      }
    });

    it('returns recovery_state = pr.checking_existing for PR ops', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'pr_prepare',
        state: 'pr.creating',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('pr.checking_existing');
      }
    });

    it('includes journal in recovery result', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.journal.operation_id).toBe('test-op-12345678');
        expect(result.journal.kind).toBe('credentials');
      }
    });

    // ---------- lock/journal operation_id alignment ----------

    it('cleans up lock with mismatched operation_id during recovery', async () => {
      // Create journal with one operation_id
      await createJournal(tempDir, {
        operation_id: 'journal-op-1234567',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });

      // Write a lock with a different operation_id (ops dir already created by createJournal)
      const mismatchedLock: ProviderOperationLock = {
        schemaVersion: 1,
        operation_id: 'lock-op-99999999',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        pid: process.pid,
      };
      await fs.writeFile(getLockPath(tempDir), JSON.stringify(mismatchedLock, null, 2) + '\n', 'utf-8');

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('ingest.validating');
      }

      // Lock should have been cleaned up due to mismatch
      expect(await readLock(tempDir)).toBeNull();
    });

    it('preserves lock with matching operation_id during recovery', async () => {
      // Acquire lock and create journal with same operation_id
      await acquireLock(tempDir, {
        operation_id: 'same-op-12345678',
        issue_ref: 'owner/repo#42',
      });
      await createJournal(tempDir, {
        operation_id: 'same-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);

      // Lock should still be present since operation_ids match
      expect(await readLock(tempDir)).not.toBeNull();
    });

    it('handles recovery when no lock exists alongside journal', async () => {
      await createJournal(tempDir, {
        operation_id: 'orphan-op-123456',
        kind: 'pr_prepare',
        state: 'pr.creating',
        issue_ref: 'owner/repo#42',
        provider: 'azure_devops',
      });

      const result = await detectRecovery(tempDir);
      expect(result.needed).toBe(true);
      if (result.needed) {
        expect(result.recovery_state).toBe('pr.checking_existing');
      }
    });
  });

  // --------------------------------------------------------------------------
  // cleanupStaleArtifacts
  // --------------------------------------------------------------------------

  describe('cleanupStaleArtifacts', () => {
    it('removes stale lock', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });

      // Write an expired lock
      const staleLock: ProviderOperationLock = {
        schemaVersion: 1,
        operation_id: 'stale-op-12345678',
        issue_ref: 'owner/repo#42',
        acquired_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        pid: process.pid,
      };
      await fs.writeFile(getLockPath(tempDir), JSON.stringify(staleLock, null, 2) + '\n', 'utf-8');

      const result = await cleanupStaleArtifacts(tempDir);
      expect(result.lock_removed).toBe(true);
      expect(await readLock(tempDir)).toBeNull();
    });

    it('does not remove active lock', async () => {
      await acquireLock(tempDir, {
        operation_id: 'active-op-12345',
        issue_ref: 'owner/repo#42',
      });

      const result = await cleanupStaleArtifacts(tempDir);
      expect(result.lock_removed).toBe(false);
      expect(await readLock(tempDir)).not.toBeNull();
    });

    it('removes completed journal', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'credentials',
        state: 'cred.validating',
        issue_ref: 'owner/repo#42',
        provider: null,
      });
      await finalizeJournal(tempDir, 'cred.done');

      const result = await cleanupStaleArtifacts(tempDir);
      expect(result.journal_removed).toBe(true);
      expect(await readJournal(tempDir)).toBeNull();
    });

    it('does not remove incomplete journal', async () => {
      await createJournal(tempDir, {
        operation_id: 'test-op-12345678',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });

      const result = await cleanupStaleArtifacts(tempDir);
      expect(result.journal_removed).toBe(false);
      expect(await readJournal(tempDir)).not.toBeNull();
    });

    it('removes temp files in .ops dir', async () => {
      const opsDir = getOpsDir(tempDir);
      await fs.mkdir(opsDir, { recursive: true });

      // Create some temp files
      await fs.writeFile(path.join(opsDir, 'something.12345.1234567890.tmp'), 'temp', 'utf-8');
      await fs.writeFile(path.join(opsDir, 'another.tmp'), 'temp', 'utf-8');

      const result = await cleanupStaleArtifacts(tempDir);
      expect(result.temp_files_removed).toBe(2);

      const entries = await fs.readdir(opsDir);
      expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
    });

    it('returns cleanup summary', async () => {
      const result = await cleanupStaleArtifacts(tempDir);
      expect(result).toEqual({
        lock_removed: false,
        journal_removed: false,
        temp_files_removed: 0,
      });
    });

    it('handles missing .ops directory gracefully', async () => {
      // Should not throw
      const result = await cleanupStaleArtifacts(tempDir);
      expect(result.temp_files_removed).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Concurrent lock behavior
  // --------------------------------------------------------------------------

  describe('concurrent lock behavior', () => {
    it('only one acquireLock succeeds under concurrent attempts', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_unused, idx) => acquireLock(tempDir, {
          operation_id: `concurrent-op-${idx.toString().padStart(8, '0')}`,
          issue_ref: 'owner/repo#42',
        })),
      );

      const acquiredCount = attempts.filter((res) => res.acquired).length;
      const busyCount = attempts.filter((res) => !res.acquired && res.reason === 'busy').length;

      expect(acquiredCount).toBe(1);
      expect(busyCount).toBe(7);
    });

    it('second acquireLock while first held returns busy', async () => {
      const first = await acquireLock(tempDir, {
        operation_id: 'first-op-12345678',
        issue_ref: 'owner/repo#42',
      });
      expect(first.acquired).toBe(true);

      const second = await acquireLock(tempDir, {
        operation_id: 'second-op-1234567',
        issue_ref: 'owner/repo#42',
      });
      expect(second).toEqual({ acquired: false, reason: 'busy' });
    });

    it('acquireLock after releaseLock succeeds', async () => {
      await acquireLock(tempDir, {
        operation_id: 'first-op-12345678',
        issue_ref: 'owner/repo#42',
      });
      await releaseLock(tempDir);

      const second = await acquireLock(tempDir, {
        operation_id: 'second-op-1234567',
        issue_ref: 'owner/repo#42',
      });
      expect(second).toEqual({ acquired: true, operation_id: 'second-op-1234567' });
    });
  });

  // --------------------------------------------------------------------------
  // Full lifecycle
  // --------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('acquireLock -> createJournal -> update -> finalize -> releaseLock', async () => {
      // 1. Acquire lock
      const lockResult = await acquireLock(tempDir, {
        operation_id: 'lifecycle-op-1234',
        issue_ref: 'owner/repo#42',
      });
      expect(lockResult.acquired).toBe(true);

      // 2. Create journal
      const journal = await createJournal(tempDir, {
        operation_id: 'lifecycle-op-1234',
        kind: 'ingest',
        state: 'ingest.validating',
        issue_ref: 'owner/repo#42',
        provider: 'github',
      });
      expect(journal.completed_at).toBeNull();

      // 3. Update state
      const updated = await updateJournalState(tempDir, 'ingest.creating_remote');
      expect(updated.state).toBe('ingest.creating_remote');

      // 4. Update checkpoint
      const checkpointed = await updateJournalCheckpoint(tempDir, {
        remote_id: '999',
        remote_url: 'https://github.com/owner/repo/issues/999',
      });
      expect(checkpointed.checkpoint.remote_id).toBe('999');

      // 5. Finalize
      const finalized = await finalizeJournal(tempDir, 'ingest.done');
      expect(finalized.completed_at).not.toBeNull();
      expect(finalized.state).toBe('ingest.done');

      // 6. Release lock
      await releaseLock(tempDir);
      expect(await readLock(tempDir)).toBeNull();

      // 7. Verify no recovery needed
      const recovery = await detectRecovery(tempDir);
      expect(recovery.needed).toBe(false);
    });
  });
});
