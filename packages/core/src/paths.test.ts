import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getIssueStateDir, getWorktreePath, parseIssueRef, parseRepoSpec, resolveDataDir } from './paths.js';

describe('resolveDataDir', () => {
  it('uses JEEVES_DATA_DIR when set (with ~ expansion)', () => {
    const dir = resolveDataDir({
      env: { JEEVES_DATA_DIR: '~/x' },
      platform: 'linux',
      homeDir: '/home/test',
    });
    expect(dir).toBe('/home/test/x');
  });

  it('uses LOCALAPPDATA on windows', () => {
    const dir = resolveDataDir({
      env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      platform: 'win32',
      homeDir: 'C:\\Users\\Test',
    });
    expect(dir).toBe(path.resolve('C:\\Users\\Test\\AppData\\Local', 'jeeves'));
  });

  it('uses Application Support on macOS', () => {
    const dir = resolveDataDir({
      env: {},
      platform: 'darwin',
      homeDir: '/Users/test',
    });
    expect(dir).toBe('/Users/test/Library/Application Support/jeeves');
  });

  it('uses XDG_DATA_HOME on linux', () => {
    const dir = resolveDataDir({
      env: { XDG_DATA_HOME: '/tmp/xdg' },
      platform: 'linux',
      homeDir: '/home/test',
    });
    expect(dir).toBe('/tmp/xdg/jeeves');
  });

  it('defaults to ~/.local/share on linux when XDG_DATA_HOME missing', () => {
    const dir = resolveDataDir({
      env: {},
      platform: 'linux',
      homeDir: '/home/test',
    });
    expect(dir).toBe('/home/test/.local/share/jeeves');
  });
});

describe('layout paths', () => {
  it('matches issues/<owner>/<repo>/<issue>/issue.json and worktrees/<owner>/<repo>/issue-<N>', () => {
    const dataDir = '/data';
    expect(getIssueStateDir('o', 'r', 38, dataDir)).toBe('/data/issues/o/r/38');
    expect(getWorktreePath('o', 'r', 38, dataDir)).toBe('/data/worktrees/o/r/issue-38');
  });
});

describe('parseRepoSpec / parseIssueRef', () => {
  it('parses common repo formats', () => {
    expect(parseRepoSpec('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoSpec('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseRepoSpec('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses Azure DevOps git URLs', () => {
    expect(
      parseRepoSpec('https://dev.azure.com/IOCHealthSystems/Software%20Development/_git/IOC-HealthSystems'),
    ).toEqual({
      owner: 'IOCHealthSystems',
      repo: 'IOC-HealthSystems',
      cloneUrl: 'https://dev.azure.com/IOCHealthSystems/Software%20Development/_git/IOC-HealthSystems',
    });
  });

  it('parses Azure DevOps git URL with trailing .git', () => {
    expect(
      parseRepoSpec('https://dev.azure.com/MyOrg/MyProject/_git/MyRepo.git'),
    ).toEqual({
      owner: 'MyOrg',
      repo: 'MyRepo',
      cloneUrl: 'https://dev.azure.com/MyOrg/MyProject/_git/MyRepo',
    });
  });

  it('parses legacy visualstudio.com git URLs', () => {
    expect(
      parseRepoSpec('https://myorg.visualstudio.com/MyProject/_git/MyRepo'),
    ).toEqual({
      owner: 'myorg',
      repo: 'MyRepo',
      cloneUrl: 'https://myorg.visualstudio.com/MyProject/_git/MyRepo',
    });
  });

  it('parses issue refs, including #123 with default repo', () => {
    expect(parseIssueRef('owner/repo#123')).toEqual({ owner: 'owner', repo: 'repo', issueNumber: 123 });
    expect(parseIssueRef('#123', { owner: 'owner', repo: 'repo' })).toEqual({ owner: 'owner', repo: 'repo', issueNumber: 123 });
    expect(parseIssueRef('https://github.com/owner/repo/issues/123')).toEqual({ owner: 'owner', repo: 'repo', issueNumber: 123 });
  });

  it('throws on invalid repo specs and issue refs', () => {
    expect(() => parseRepoSpec('')).toThrow(/repo spec is required/);
    expect(() => parseRepoSpec('https://example.com/owner/repo')).toThrow(/invalid repo spec/);
    expect(() => parseRepoSpec('https://github.com/owner')).toThrow(/invalid repo spec/);

    expect(() => parseIssueRef('')).toThrow(/issue ref is required/);
    expect(() => parseIssueRef('123')).toThrow(/requires a repo/);
    expect(() => parseIssueRef('#0', { owner: 'o', repo: 'r' })).toThrow(/invalid issue number/);
    expect(() => parseIssueRef('owner/repo#x')).toThrow(/invalid issue number/);
  });
});
