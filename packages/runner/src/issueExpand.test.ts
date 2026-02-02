import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import type { ProviderEvent, ProviderRunOptions } from './provider.js';
import { FakeProvider } from './providers/fake.js';
import { expandIssue } from './issueExpand.js';

function getRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..');
}

/**
 * Extended FakeProvider that allows configuring the assistant output for testing.
 * This still uses FakeProvider (no credentials required) but enables success-path testing.
 */
class ConfigurableFakeProvider extends FakeProvider {
  private customOutput: string;

  constructor(output: string) {
    super();
    this.customOutput = output;
  }

  override async *run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent> {
    void options;
    const model = process.env.JEEVES_MODEL;
    const modelInfo = model ? ` (model=${model})` : '';
    yield {
      type: 'system',
      subtype: 'init',
      content: `Fake provider init${modelInfo}`,
      sessionId: 'fake-session',
      timestamp: new Date().toISOString(),
    };
    yield { type: 'user', content: prompt.slice(0, 2000), timestamp: new Date().toISOString() };
    yield { type: 'assistant', content: this.customOutput, timestamp: new Date().toISOString() };
    yield { type: 'result', content: '<promise>COMPLETE</promise>', timestamp: new Date().toISOString() };
  }
}

/**
 * Helper to mock stdin with given JSON input
 */
function mockStdin(input: unknown): void {
  const jsonStr = JSON.stringify(input);
  const readable = Readable.from([Buffer.from(jsonStr, 'utf-8')]);
  Object.defineProperty(process, 'stdin', {
    value: readable,
    writable: true,
    configurable: true,
  });
}

describe('expandIssue', () => {
  const originalStdin = process.stdin;
  let promptsDir: string;

  beforeEach(async () => {
    // Use the actual prompts directory from the repo
    promptsDir = path.join(getRepoRoot(), 'prompts');
  });

  afterEach(() => {
    // Restore original stdin
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  describe('success case', () => {
    it('returns ok:true with title and body on valid provider output', async () => {
      const validOutput = JSON.stringify({
        title: 'Test Issue Title',
        body: '## Summary\n\nThis is a test issue body.',
      });

      mockStdin({ summary: 'Add a test feature' });

      const result = await expandIssue({
        provider: new ConfigurableFakeProvider(validOutput),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.title).toBe('Test Issue Title');
        expect(result.body).toBe('## Summary\n\nThis is a test issue body.');
      }
    });

    it('works with optional issue_type and repo fields', async () => {
      const validOutput = JSON.stringify({
        title: 'Bug Fix Title',
        body: '## Summary\n\nBug description.',
      });

      mockStdin({
        summary: 'Fix login bug',
        issue_type: 'bug',
        repo: 'owner/repo',
      });

      const result = await expandIssue({
        provider: new ConfigurableFakeProvider(validOutput),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('invalid input case', () => {
    it('returns ok:false when summary is missing', async () => {
      mockStdin({ issue_type: 'feature' });

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('summary');
      }
    });

    it('returns ok:false when summary is empty', async () => {
      mockStdin({ summary: '' });

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('summary');
      }
    });

    it('returns ok:false when input is not an object', async () => {
      mockStdin('not an object');

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('JSON object');
      }
    });

    it('returns ok:false when issue_type is invalid', async () => {
      mockStdin({ summary: 'Test', issue_type: 'invalid' });

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('issue_type');
      }
    });

    it('returns ok:false when stdin is invalid JSON', async () => {
      const readable = Readable.from([Buffer.from('not valid json', 'utf-8')]);
      Object.defineProperty(process, 'stdin', {
        value: readable,
        writable: true,
        configurable: true,
      });

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('malformed provider output case', () => {
    it('returns ok:false when provider output is not valid JSON (using FakeProvider)', async () => {
      // FakeProvider returns "Hello from FakeProvider." which is not valid JSON
      mockStdin({ summary: 'Add a feature' });

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not valid JSON');
      }
    });

    it('returns ok:false when provider output is missing title', async () => {
      const invalidOutput = JSON.stringify({
        body: '## Summary\n\nNo title here.',
      });

      mockStdin({ summary: 'Add a feature' });

      const result = await expandIssue({
        provider: new ConfigurableFakeProvider(invalidOutput),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('title');
      }
    });

    it('returns ok:false when provider output is missing body', async () => {
      const invalidOutput = JSON.stringify({
        title: 'Title Only',
      });

      mockStdin({ summary: 'Add a feature' });

      const result = await expandIssue({
        provider: new ConfigurableFakeProvider(invalidOutput),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('body');
      }
    });

    it('returns ok:false when provider output has empty title', async () => {
      const invalidOutput = JSON.stringify({
        title: '',
        body: '## Summary\n\nBody content.',
      });

      mockStdin({ summary: 'Add a feature' });

      const result = await expandIssue({
        provider: new ConfigurableFakeProvider(invalidOutput),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('title');
      }
    });

    it('returns ok:false when provider output has empty body', async () => {
      const invalidOutput = JSON.stringify({
        title: 'Valid Title',
        body: '',
      });

      mockStdin({ summary: 'Add a feature' });

      const result = await expandIssue({
        provider: new ConfigurableFakeProvider(invalidOutput),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('body');
      }
    });

    it('does not leak raw model output in error messages', async () => {
      // FakeProvider returns "Hello from FakeProvider." which is not valid JSON
      mockStdin({ summary: 'Add a feature' });

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'issue.expand.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error message should not contain the raw provider output
        expect(result.error).not.toContain('Hello from FakeProvider');
      }
    });
  });

  describe('prompt loading', () => {
    it('returns ok:false when prompt file does not exist', async () => {
      mockStdin({ summary: 'Add a feature' });

      const result = await expandIssue({
        provider: new FakeProvider(),
        promptsDir,
        promptId: 'nonexistent.md',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Failed to load prompt template');
      }
    });
  });
});
