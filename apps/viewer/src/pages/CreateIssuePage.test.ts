import { describe, expect, it } from 'vitest';

import {
  applyExpansionResult,
  restoreFromUndo,
  buildExpandRequestFromState,
  type UndoState,
} from './CreateIssuePage.js';

/**
 * Tests for CreateIssuePage.tsx helper functions.
 *
 * These tests verify:
 * - Mutation request serialization (buildExpandRequestFromState)
 * - Apply/undo state transitions (applyExpansionResult, restoreFromUndo)
 */

describe('buildExpandRequestFromState', () => {
  describe('summary handling', () => {
    it('trims summary whitespace', () => {
      const result = buildExpandRequestFromState('  test summary  ', undefined, undefined, undefined);
      expect(result.summary).toBe('test summary');
    });

    it('includes trimmed summary', () => {
      const result = buildExpandRequestFromState('Add feature', undefined, undefined, undefined);
      expect(result.summary).toBe('Add feature');
    });
  });

  describe('issue type handling', () => {
    it('includes issue_type when provided', () => {
      const result = buildExpandRequestFromState('Test', 'feature', undefined, undefined);
      expect(result.issue_type).toBe('feature');
    });

    it('handles all issue types', () => {
      const types = ['feature', 'bug', 'refactor'] as const;
      for (const type of types) {
        const result = buildExpandRequestFromState('Test', type, undefined, undefined);
        expect(result.issue_type).toBe(type);
      }
    });

    it('omits issue_type when undefined', () => {
      const result = buildExpandRequestFromState('Test', undefined, undefined, undefined);
      expect('issue_type' in result).toBe(false);
    });
  });

  describe('provider handling', () => {
    it('includes provider when provided', () => {
      const result = buildExpandRequestFromState('Test', undefined, 'codex', undefined);
      expect(result.provider).toBe('codex');
    });
  });

  describe('model handling', () => {
    it('includes model when provided', () => {
      const result = buildExpandRequestFromState('Test', undefined, undefined, 'gpt-4');
      expect(result.model).toBe('gpt-4');
    });
  });
});

describe('applyExpansionResult', () => {
  describe('basic application', () => {
    it('returns generated title and body as new values', () => {
      const result = applyExpansionResult(
        'old title',
        'old body',
        'generated title',
        'generated body',
      );

      expect(result.newTitle).toBe('generated title');
      expect(result.newBody).toBe('generated body');
    });

    it('stores current values in undo state', () => {
      const result = applyExpansionResult(
        'current title',
        'current body',
        'new title',
        'new body',
      );

      expect(result.undoState).not.toBeNull();
      expect(result.undoState?.title).toBe('current title');
      expect(result.undoState?.body).toBe('current body');
    });
  });

  describe('edge cases', () => {
    it('handles empty current values', () => {
      const result = applyExpansionResult('', '', 'generated', 'content');

      expect(result.newTitle).toBe('generated');
      expect(result.newBody).toBe('content');
      expect(result.undoState?.title).toBe('');
      expect(result.undoState?.body).toBe('');
    });

    it('preserves prior input with content', () => {
      const result = applyExpansionResult(
        'User typed title',
        'User wrote a detailed body with\nmultiple lines',
        'AI Title',
        'AI Body',
      );

      // Undo state should preserve the user's original input
      expect(result.undoState?.title).toBe('User typed title');
      expect(result.undoState?.body).toBe('User wrote a detailed body with\nmultiple lines');
    });
  });
});

describe('restoreFromUndo', () => {
  describe('successful restoration', () => {
    it('returns stored title and body when undo state exists', () => {
      const undoState: UndoState = { title: 'saved title', body: 'saved body' };
      const result = restoreFromUndo(undoState);

      expect(result).not.toBeNull();
      expect(result?.title).toBe('saved title');
      expect(result?.body).toBe('saved body');
    });

    it('preserves empty strings in undo state', () => {
      const undoState: UndoState = { title: '', body: '' };
      const result = restoreFromUndo(undoState);

      expect(result?.title).toBe('');
      expect(result?.body).toBe('');
    });
  });

  describe('null undo state', () => {
    it('returns null when undo state is null', () => {
      const result = restoreFromUndo(null);
      expect(result).toBeNull();
    });
  });
});

describe('apply/undo state transitions', () => {
  it('full cycle: initial -> apply -> undo', () => {
    // Initial state
    const initialTitle = 'My Issue Title';
    const initialBody = 'This is my issue description.';

    // Apply expansion
    const applyResult = applyExpansionResult(
      initialTitle,
      initialBody,
      'AI Generated Title',
      '## Summary\nAI generated description.',
    );

    // After apply, we have new values and undo state
    expect(applyResult.newTitle).toBe('AI Generated Title');
    expect(applyResult.newBody).toBe('## Summary\nAI generated description.');
    expect(applyResult.undoState).toEqual({
      title: initialTitle,
      body: initialBody,
    });

    // Undo to restore original
    const undoResult = restoreFromUndo(applyResult.undoState);

    expect(undoResult).toEqual({
      title: initialTitle,
      body: initialBody,
    });
  });

  it('apply when fields are empty preserves empty undo state', () => {
    // User has not typed anything yet
    const applyResult = applyExpansionResult(
      '',
      '',
      'Generated Title',
      'Generated Body',
    );

    expect(applyResult.undoState?.title).toBe('');
    expect(applyResult.undoState?.body).toBe('');

    // Undo restores empty state
    const undoResult = restoreFromUndo(applyResult.undoState);
    expect(undoResult?.title).toBe('');
    expect(undoResult?.body).toBe('');
  });

  it('multiple apply/undo cycles work correctly', () => {
    // First apply
    const first = applyExpansionResult('Original', 'Content', 'Gen1', 'Body1');
    expect(first.undoState?.title).toBe('Original');

    // Simulate undo
    const restored1 = restoreFromUndo(first.undoState);
    expect(restored1?.title).toBe('Original');

    // Second apply (user starts fresh)
    const second = applyExpansionResult(
      restored1?.title ?? '',
      restored1?.body ?? '',
      'Gen2',
      'Body2',
    );
    expect(second.newTitle).toBe('Gen2');
    expect(second.undoState?.title).toBe('Original');

    // Second undo
    const restored2 = restoreFromUndo(second.undoState);
    expect(restored2?.title).toBe('Original');
    expect(restored2?.body).toBe('Content');
  });
});
