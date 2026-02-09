import type { MemoryEntry } from '@jeeves/state-db';
import { describe, expect, it } from 'vitest';

import {
  buildTrajectoryReflectionPrompt,
  reflectTrajectory,
} from './trajectoryReflection.js';

function makeMemoryEntry(params: {
  key: string;
  value: Record<string, unknown>;
  scope?: MemoryEntry['scope'];
}): MemoryEntry {
  return {
    stateDir: '/tmp/jeeves-test',
    scope: params.scope ?? 'working_set',
    key: params.key,
    value: params.value,
    sourceIteration: 1,
    stale: false,
    createdAt: '2026-02-09T00:00:00.000Z',
    updatedAt: '2026-02-09T00:00:00.000Z',
  };
}

describe('trajectoryReflection', () => {
  it('builds prompt text with objective, memory entries, tasks, and previous snapshot', () => {
    const prompt = buildTrajectoryReflectionPrompt({
      objective: 'Reduce stale context while preserving blockers.',
      memoryEntries: [
        makeMemoryEntry({
          key: 'blocker:ci-red',
          value: { blocker: 'CI is red due to failing tests.' },
        }),
      ],
      previousSnapshot: {
        current_objective: 'Stabilize CI',
        open_hypotheses: ['Hypothesis A'],
        blockers: ['CI red'],
        next_actions: ['Run tests'],
        unresolved_questions: ['Why are tests flaky?'],
        required_evidence_links: ['https://example.test/evidence'],
      },
      tasks: [{ id: 'T1', title: 'Fix tests', status: 'in_progress' }],
    });

    expect(prompt).toContain('## Current Objective');
    expect(prompt).toContain('Reduce stale context while preserving blockers.');
    expect(prompt).toContain('blocker:ci-red');
    expect(prompt).toContain('Fix tests');
    expect(prompt).toContain('"current_objective"');
  });

  it('returns parsed reflection snapshot and diagnostics from SDK-like events', async () => {
    let capturedPrompt = '';
    const result = await reflectTrajectory({
      objective: 'Stabilize CI and reduce stale context.',
      memoryEntries: [
        makeMemoryEntry({
          key: 'blocker:ci-red',
          value: { blocker: 'CI is red with 3 failing tests.' },
        }),
        makeMemoryEntry({
          key: 'next:rerun-tests',
          value: { nextAction: 'Rerun the failing integration suite.' },
        }),
      ],
      previousSnapshot: null,
      tasks: [{ id: 'T1', title: 'Fix integration tests', status: 'in_progress' }],
      queryFn: (input) => {
        capturedPrompt = input.prompt;
        return (async function* () {
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    current_objective: 'Stabilize CI and reduce stale context',
                    open_hypotheses: ['Integration suite is flaky under parallel load'],
                    blockers: ['CI red: 3 failing tests'],
                    next_actions: ['Rerun integration suite and capture logs'],
                    unresolved_questions: [],
                    required_evidence_links: [],
                    dropped: [{ value: 'Old stale note', reason: 'stale' }],
                  }),
                },
              ],
            },
          };
          yield {
            type: 'result',
            usage: { input_tokens: 222, output_tokens: 111 },
          };
        })();
      },
    });

    expect(capturedPrompt).toContain('Stabilize CI and reduce stale context.');
    expect(result.snapshot.blockers).toEqual(['CI red: 3 failing tests']);
    expect(result.snapshot.next_actions).toEqual(['Rerun integration suite and capture logs']);
    expect(result.diagnostics.input_tokens).toBe(222);
    expect(result.diagnostics.output_tokens).toBe(111);
    expect(result.diagnostics.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.dropped).toEqual([{ value: 'Old stale note', reason: 'stale' }]);
  });

  it('rejects malformed JSON responses', async () => {
    await expect(
      reflectTrajectory({
        objective: 'Objective',
        memoryEntries: [
          makeMemoryEntry({
            key: 'hypothesis:test',
            value: { hypothesis: 'Keyword-only classification is noisy.' },
          }),
        ],
        previousSnapshot: null,
        tasks: [],
        queryFn: () =>
          (async function* () {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'not-json' }] },
            };
          })(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('rejects hallucinated reflected items that do not trace to source data', async () => {
    await expect(
      reflectTrajectory({
        objective: 'Fix failing tests.',
        memoryEntries: [
          makeMemoryEntry({
            key: 'blocker:ci-red',
            value: { blocker: 'CI is red due to failing tests.' },
          }),
        ],
        previousSnapshot: null,
        tasks: [],
        queryFn: () =>
          (async function* () {
            yield {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      current_objective: 'Fix failing tests',
                      open_hypotheses: [],
                      blockers: ['Procure an Iceland GPU cluster'],
                      next_actions: [],
                      unresolved_questions: [],
                      required_evidence_links: [],
                      dropped: [],
                    }),
                  },
                ],
              },
            };
          })(),
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects when no assistant content is returned', async () => {
    await expect(
      reflectTrajectory({
        objective: 'Objective',
        memoryEntries: [],
        previousSnapshot: null,
        tasks: [],
        queryFn: () =>
          (async function* () {
            yield { type: 'result', usage: { input_tokens: 10, output_tokens: 1 } };
          })(),
      }),
    ).rejects.toMatchObject({ code: 'no_assistant_output' });
  });
});
