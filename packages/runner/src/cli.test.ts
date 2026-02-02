import { describe, expect, it, vi } from 'vitest';

describe('runner CLI failure exit behavior', () => {
  it('run-phase throws when runner returns success=false', async () => {
    vi.resetModules();
    vi.doMock('./runner.js', () => ({
      runSinglePhaseOnce: vi.fn(async () => ({ phase: 'hello', success: false })),
      runWorkflowOnce: vi.fn(async () => ({ finalPhase: 'hello', success: true })),
    }));

    const { main } = await import('./cli.js');
    await expect(
      main([
        'run-phase',
        '--provider',
        'fake',
        '--workflow',
        'fixture-trivial',
        '--phase',
        'hello',
        '--workflows-dir',
        '/tmp/workflows',
        '--prompts-dir',
        '/tmp/prompts',
        '--state-dir',
        '/tmp/state',
        '--work-dir',
        '/tmp/work',
      ]),
    ).rejects.toThrow(/run-phase failed/i);
  });

  it('run-workflow throws when runner returns success=false', async () => {
    vi.resetModules();
    vi.doMock('./runner.js', () => ({
      runSinglePhaseOnce: vi.fn(async () => ({ phase: 'hello', success: true })),
      runWorkflowOnce: vi.fn(async () => ({ finalPhase: 'hello', success: false })),
    }));

    const { main } = await import('./cli.js');
    await expect(
      main([
        'run-workflow',
        '--provider',
        'fake',
        '--workflow',
        'fixture-trivial',
        '--workflows-dir',
        '/tmp/workflows',
        '--prompts-dir',
        '/tmp/prompts',
        '--state-dir',
        '/tmp/state',
        '--work-dir',
        '/tmp/work',
      ]),
    ).rejects.toThrow(/run-workflow failed/i);
  });
});
