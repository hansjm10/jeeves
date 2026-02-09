import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendProgressEvent, markMemoryEntryStaleInDb, upsertMemoryEntryInDb } from '@jeeves/state-db';
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_CONTEXT_FILE,
  RETIRED_TRAJECTORY_FILE,
  computeTrajectoryReduction,
  mergeTrajectoryReductionSummary,
} from './trajectoryReduction.js';

async function makeStateDir(prefix: string): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(dataDir, 'issues', 'acme', 'rocket', '113');
  await fs.mkdir(stateDir, { recursive: true });
  return stateDir;
}

describe('trajectoryReduction', () => {
  it('builds active snapshot fields and retires obsolete branches across iterations', async () => {
    const stateDir = await makeStateDir('jeeves-trajectory-');

    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify(
        {
          repo: 'acme/rocket',
          issue: { number: 113, title: 'Add iteration trajectory reduction' },
          phase: 'implement_task',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(stateDir, 'tasks.json'),
      JSON.stringify(
        {
          tasks: [
            { id: 'T1', title: 'Wire reducer', status: 'in_progress' },
            { id: 'T2', title: 'Stabilize metrics', status: 'failed' },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    appendProgressEvent({
      stateDir,
      source: 'test',
      message: 'Started: 2026-02-09T00:00:00.000Z\nShould repeated-context rate include objective?',
    });
    await fs.writeFile(
      path.join(stateDir, 'sdk-output.json'),
      JSON.stringify(
        {
          tool_calls: [
            {
              name: 'mcp:pruner/read',
              input: { file_path: 'apps/viewer-server/src/runManager.ts' },
              response_retrieval: {
                status: 'available',
                handle: 'tool-output://abc',
                artifact_paths: ['tool-raw/tool_r1.part-001.txt'],
              },
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'hypothesis:memory-first',
      value: { hypothesis: 'Structured memory first reduces stale replay.' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'blocker:metrics-schema',
      value: { blocker: 'Need reduction metric schema finalized.' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'next:wire-run-manager',
      value: { nextAction: 'Integrate reducer into runManager iteration archive.' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'question:token-estimate',
      value: { question: 'How should active snapshot token size be estimated?' },
      sourceIteration: 1,
    });
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'evidence:reference',
      value: { evidence: 'https://arxiv.org/abs/2509.23586' },
      sourceIteration: 1,
    });

    const first = await computeTrajectoryReduction({
      stateDir,
      iteration: 1,
    });

    expect(first.snapshot.current_objective).toContain('Add iteration trajectory reduction');
    expect(first.snapshot.open_hypotheses.some((entry) => entry.includes('hypothesis:memory-first'))).toBe(true);
    expect(first.snapshot.blockers.some((entry) => entry.includes('blocker:metrics-schema'))).toBe(true);
    expect(first.snapshot.blockers.some((entry) => entry.includes('Task T2'))).toBe(true);
    expect(first.snapshot.next_actions.some((entry) => entry.includes('next:wire-run-manager'))).toBe(true);
    expect(first.snapshot.unresolved_questions.some((entry) => entry.includes('question:token-estimate'))).toBe(true);
    expect(first.snapshot.unresolved_questions.some((entry) => entry.includes('Should repeated-context rate include objective?'))).toBe(true);
    expect(first.snapshot.required_evidence_links).toEqual(
      expect.arrayContaining([
        'https://arxiv.org/abs/2509.23586',
        'tool-output://abc',
        'tool-raw/tool_r1.part-001.txt',
      ]),
    );
    expect(first.diagnostics.retired_branch_count).toBe(0);

    expect(markMemoryEntryStaleInDb({ stateDir, scope: 'working_set', key: 'hypothesis:memory-first' })).toBe(true);
    upsertMemoryEntryInDb({
      stateDir,
      scope: 'working_set',
      key: 'hypothesis:active-snapshot',
      value: { hypothesis: 'Active snapshot handoff keeps context stable across iterations.' },
      sourceIteration: 2,
    });

    const second = await computeTrajectoryReduction({
      stateDir,
      iteration: 2,
    });
    expect(second.retired.length).toBeGreaterThan(0);
    expect(
      second.retired.some((record) => record.field === 'open_hypotheses' && record.value.includes('hypothesis:memory-first')),
    ).toBe(true);
    expect(second.diagnostics.retired_branch_count).toBeGreaterThan(0);
    expect(second.diagnostics.active_snapshot_token_size).toBeGreaterThan(0);
    expect(second.diagnostics.repeated_context_rate).toBeGreaterThanOrEqual(0);

    const summary = mergeTrajectoryReductionSummary(
      mergeTrajectoryReductionSummary(null, first.diagnostics),
      second.diagnostics,
    );
    expect(summary.iterations_with_reduction).toBe(2);
    expect(summary.total_retired_branch_count).toBeGreaterThan(0);

    const activeContextOnDisk = await fs.readFile(path.join(stateDir, ACTIVE_CONTEXT_FILE), 'utf-8');
    expect(activeContextOnDisk).toContain('"iteration": 2');
    const retiredOnDisk = await fs.readFile(path.join(stateDir, RETIRED_TRAJECTORY_FILE), 'utf-8');
    expect(retiredOnDisk).toContain('hypothesis:memory-first');
  });

  it('counts repeated items across the full snapshot for diagnostics', async () => {
    const stateDir = await makeStateDir('jeeves-trajectory-full-count-');

    await fs.writeFile(
      path.join(stateDir, 'issue.json'),
      JSON.stringify(
        {
          repo: 'acme/rocket',
          issue: { number: 114 },
          phase: 'implement_task',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const blockedTasks = Array.from({ length: 25 }, (_, index) => ({
      id: `B-${index + 1}`,
      title: `Blocked task ${index + 1}`,
      status: 'blocked',
    }));
    const pendingTasks = Array.from({ length: 25 }, (_, index) => ({
      id: `N-${index + 1}`,
      title: `Pending task ${index + 1}`,
      status: 'pending',
    }));
    await fs.writeFile(
      path.join(stateDir, 'tasks.json'),
      JSON.stringify({ tasks: [...blockedTasks, ...pendingTasks] }, null, 2) + '\n',
      'utf-8',
    );
    await fs.writeFile(path.join(stateDir, 'sdk-output.json'), JSON.stringify({ tool_calls: [] }, null, 2) + '\n', 'utf-8');

    const first = await computeTrajectoryReduction({
      stateDir,
      iteration: 1,
    });
    expect(first.diagnostics.active_item_count).toBeGreaterThan(25);
    expect(first.diagnostics.repeated_item_count).toBe(0);

    const second = await computeTrajectoryReduction({
      stateDir,
      iteration: 2,
    });
    expect(second.diagnostics.active_item_count).toBe(first.diagnostics.active_item_count);
    expect(second.diagnostics.repeated_item_count).toBe(second.diagnostics.active_item_count);
    expect(second.diagnostics.repeated_context_rate).toBe(1);
  });
});
