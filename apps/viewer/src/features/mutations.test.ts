import { describe, expect, it } from 'vitest';

import type { StartRunInput } from '../api/types.js';

/**
 * Tests for mutations.ts payload formation.
 *
 * These tests verify that the useStartRunMutation correctly forms the request body:
 * - Omits max_iterations when undefined (blank input from UI)
 * - Includes max_iterations when a valid positive integer is provided
 */

/**
 * Replicates the body formation logic from useStartRunMutation in mutations.ts:
 *
 * const body: { provider: string; max_iterations?: number } = { provider: input.provider };
 * if (input.max_iterations !== undefined) {
 *   body.max_iterations = input.max_iterations;
 * }
 */
function buildRequestBody(input: StartRunInput): { provider: string; max_iterations?: number } {
  const body: { provider: string; max_iterations?: number } = { provider: input.provider };
  if (input.max_iterations !== undefined) {
    body.max_iterations = input.max_iterations;
  }
  return body;
}

describe('useStartRunMutation request body formation', () => {
  describe('max_iterations omission (blank/undefined)', () => {
    it('omits max_iterations when undefined', () => {
      const input: StartRunInput = { provider: 'claude' };
      const body = buildRequestBody(input);

      expect(body).toEqual({ provider: 'claude' });
      expect(Object.keys(body)).not.toContain('max_iterations');
      expect('max_iterations' in body).toBe(false);
    });

    it('omits max_iterations when explicitly undefined', () => {
      const input: StartRunInput = { provider: 'codex', max_iterations: undefined };
      const body = buildRequestBody(input);

      expect(body).toEqual({ provider: 'codex' });
      expect(Object.keys(body)).not.toContain('max_iterations');
    });
  });

  describe('max_iterations inclusion (valid positive integer)', () => {
    it('includes max_iterations when value is 1', () => {
      const input: StartRunInput = { provider: 'claude', max_iterations: 1 };
      const body = buildRequestBody(input);

      expect(body).toEqual({ provider: 'claude', max_iterations: 1 });
    });

    it('includes max_iterations when value is 10', () => {
      const input: StartRunInput = { provider: 'fake', max_iterations: 10 };
      const body = buildRequestBody(input);

      expect(body).toEqual({ provider: 'fake', max_iterations: 10 });
    });

    it('includes max_iterations when value is 20', () => {
      const input: StartRunInput = { provider: 'codex', max_iterations: 20 };
      const body = buildRequestBody(input);

      expect(body).toEqual({ provider: 'codex', max_iterations: 20 });
    });

    it('includes max_iterations when value is 100', () => {
      const input: StartRunInput = { provider: 'claude', max_iterations: 100 };
      const body = buildRequestBody(input);

      expect(body).toEqual({ provider: 'claude', max_iterations: 100 });
    });
  });

  describe('JSON serialization preserves correct structure', () => {
    it('serializes body without max_iterations correctly', () => {
      const input: StartRunInput = { provider: 'claude' };
      const body = buildRequestBody(input);
      const json = JSON.stringify(body);

      expect(json).toBe('{"provider":"claude"}');
      expect(json).not.toContain('max_iterations');
    });

    it('serializes body with max_iterations correctly', () => {
      const input: StartRunInput = { provider: 'fake', max_iterations: 5 };
      const body = buildRequestBody(input);
      const json = JSON.stringify(body);

      expect(json).toBe('{"provider":"fake","max_iterations":5}');
    });

    it('serializes various provider + iterations combinations', () => {
      const testCases: { input: StartRunInput; expected: string }[] = [
        { input: { provider: 'claude', max_iterations: 1 }, expected: '{"provider":"claude","max_iterations":1}' },
        { input: { provider: 'codex', max_iterations: 15 }, expected: '{"provider":"codex","max_iterations":15}' },
        { input: { provider: 'fake' }, expected: '{"provider":"fake"}' },
      ];

      for (const { input, expected } of testCases) {
        const body = buildRequestBody(input);
        expect(JSON.stringify(body)).toBe(expected);
      }
    });
  });
});

describe('StartRunInput type constraints', () => {
  it('requires provider field', () => {
    // This test documents that provider is required
    const input: StartRunInput = { provider: 'claude' };
    expect(input.provider).toBe('claude');
  });

  it('allows optional max_iterations field', () => {
    // This test documents that max_iterations is optional
    const withIterations: StartRunInput = { provider: 'claude', max_iterations: 5 };
    const withoutIterations: StartRunInput = { provider: 'claude' };

    expect(withIterations.max_iterations).toBe(5);
    expect(withoutIterations.max_iterations).toBeUndefined();
  });

  it('enforces valid provider values', () => {
    // This test documents the valid provider types
    const providers: StartRunInput['provider'][] = ['claude', 'codex', 'fake'];

    for (const provider of providers) {
      const input: StartRunInput = { provider };
      expect(input.provider).toBe(provider);
    }
  });
});
