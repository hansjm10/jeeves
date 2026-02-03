import { describe, expect, it } from 'vitest';

import {
  isTaskReady,
  scheduleReadyTasks,
  selectReadyTasks,
  TaskSchedulerError,
  validateTaskGraph,
  type Task,
  type TasksFile,
  type TaskStatus,
} from './taskScheduler.js';

describe('validateTaskGraph', () => {
  describe('unique IDs validation', () => {
    it('accepts tasks with unique IDs', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending' },
        { id: 'T3', status: 'pending' },
      ];
      expect(() => validateTaskGraph(tasks)).not.toThrow();
    });

    it('rejects duplicate task IDs with clear error', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending' },
        { id: 'T1', status: 'pending' },
      ];
      expect(() => validateTaskGraph(tasks)).toThrow(TaskSchedulerError);
      try {
        validateTaskGraph(tasks);
      } catch (e) {
        expect(e).toBeInstanceOf(TaskSchedulerError);
        const err = e as TaskSchedulerError;
        expect(err.code).toBe('DUPLICATE_ID');
        expect(err.message).toContain("Duplicate task ID 'T1'");
        expect(err.details?.taskId).toBe('T1');
        expect(err.details?.firstIndex).toBe(0);
        expect(err.details?.secondIndex).toBe(2);
      }
    });
  });

  describe('dependency references validation', () => {
    it('accepts valid dependency references', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending', dependsOn: ['T1'] },
        { id: 'T3', status: 'pending', dependsOn: ['T1', 'T2'] },
      ];
      expect(() => validateTaskGraph(tasks)).not.toThrow();
    });

    it('accepts tasks with no dependencies', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending', dependsOn: [] },
      ];
      expect(() => validateTaskGraph(tasks)).not.toThrow();
    });

    it('rejects missing dependency IDs with clear error', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending', dependsOn: ['T3'] },
      ];
      expect(() => validateTaskGraph(tasks)).toThrow(TaskSchedulerError);
      try {
        validateTaskGraph(tasks);
      } catch (e) {
        expect(e).toBeInstanceOf(TaskSchedulerError);
        const err = e as TaskSchedulerError;
        expect(err.code).toBe('MISSING_DEPENDENCY');
        expect(err.message).toContain("Task 'T2' depends on non-existent task 'T3'");
        expect(err.details?.taskId).toBe('T2');
        expect(err.details?.missingDependency).toBe('T3');
      }
    });
  });

  describe('cycle detection', () => {
    it('accepts acyclic graphs', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending', dependsOn: ['T1'] },
        { id: 'T3', status: 'pending', dependsOn: ['T1'] },
        { id: 'T4', status: 'pending', dependsOn: ['T2', 'T3'] },
      ];
      expect(() => validateTaskGraph(tasks)).not.toThrow();
    });

    it('rejects self-referencing cycles', () => {
      const tasks: Task[] = [{ id: 'T1', status: 'pending', dependsOn: ['T1'] }];
      expect(() => validateTaskGraph(tasks)).toThrow(TaskSchedulerError);
      try {
        validateTaskGraph(tasks);
      } catch (e) {
        expect(e).toBeInstanceOf(TaskSchedulerError);
        const err = e as TaskSchedulerError;
        expect(err.code).toBe('CYCLE_DETECTED');
        expect(err.message).toContain('Cycle detected');
        expect(err.details?.cycle).toEqual(['T1', 'T1']);
      }
    });

    it('rejects two-task cycles', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending', dependsOn: ['T2'] },
        { id: 'T2', status: 'pending', dependsOn: ['T1'] },
      ];
      expect(() => validateTaskGraph(tasks)).toThrow(TaskSchedulerError);
      try {
        validateTaskGraph(tasks);
      } catch (e) {
        expect(e).toBeInstanceOf(TaskSchedulerError);
        const err = e as TaskSchedulerError;
        expect(err.code).toBe('CYCLE_DETECTED');
        expect(err.message).toContain('Cycle detected');
      }
    });

    it('rejects longer cycles with clear path', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending', dependsOn: ['T3'] },
        { id: 'T2', status: 'pending', dependsOn: ['T1'] },
        { id: 'T3', status: 'pending', dependsOn: ['T2'] },
      ];
      expect(() => validateTaskGraph(tasks)).toThrow(TaskSchedulerError);
      try {
        validateTaskGraph(tasks);
      } catch (e) {
        expect(e).toBeInstanceOf(TaskSchedulerError);
        const err = e as TaskSchedulerError;
        expect(err.code).toBe('CYCLE_DETECTED');
        expect(err.message).toContain('Cycle detected');
        // The cycle path should show the full cycle
        const cycle = err.details?.cycle as string[];
        expect(cycle).toBeDefined();
        expect(cycle.length).toBeGreaterThanOrEqual(2);
        // First and last element should be the same (cycle start/end)
        expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      }
    });

    it('accepts complex DAG without cycles', () => {
      // Diamond pattern: T1 -> T2, T1 -> T3, T2 -> T4, T3 -> T4
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending', dependsOn: ['T1'] },
        { id: 'T3', status: 'pending', dependsOn: ['T1'] },
        { id: 'T4', status: 'pending', dependsOn: ['T2', 'T3'] },
      ];
      expect(() => validateTaskGraph(tasks)).not.toThrow();
    });
  });
});

describe('isTaskReady', () => {
  const makeStatusMap = (tasks: Task[]): Map<string, TaskStatus> => {
    const map = new Map<string, TaskStatus>();
    for (const task of tasks) {
      map.set(task.id, task.status);
    }
    return map;
  };

  it('returns true for pending task with no dependencies', () => {
    const task: Task = { id: 'T1', status: 'pending' };
    const statusMap = makeStatusMap([task]);
    expect(isTaskReady(task, statusMap)).toBe(true);
  });

  it('returns true for failed task with no dependencies (retryable)', () => {
    const task: Task = { id: 'T1', status: 'failed' };
    const statusMap = makeStatusMap([task]);
    expect(isTaskReady(task, statusMap)).toBe(true);
  });

  it('returns false for in_progress task (not schedulable)', () => {
    const task: Task = { id: 'T1', status: 'in_progress' };
    const statusMap = makeStatusMap([task]);
    expect(isTaskReady(task, statusMap)).toBe(false);
  });

  it('returns false for passed task', () => {
    const task: Task = { id: 'T1', status: 'passed' };
    const statusMap = makeStatusMap([task]);
    expect(isTaskReady(task, statusMap)).toBe(false);
  });

  it('returns true when all dependencies are passed', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'passed' },
      { id: 'T2', status: 'passed' },
      { id: 'T3', status: 'pending', dependsOn: ['T1', 'T2'] },
    ];
    const statusMap = makeStatusMap(tasks);
    expect(isTaskReady(tasks[2], statusMap)).toBe(true);
  });

  it('returns false when dependency is pending', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'pending' },
      { id: 'T2', status: 'pending', dependsOn: ['T1'] },
    ];
    const statusMap = makeStatusMap(tasks);
    expect(isTaskReady(tasks[1], statusMap)).toBe(false);
  });

  it('returns false when dependency is failed', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'failed' },
      { id: 'T2', status: 'pending', dependsOn: ['T1'] },
    ];
    const statusMap = makeStatusMap(tasks);
    expect(isTaskReady(tasks[1], statusMap)).toBe(false);
  });

  it('returns false when dependency is in_progress', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'in_progress' },
      { id: 'T2', status: 'pending', dependsOn: ['T1'] },
    ];
    const statusMap = makeStatusMap(tasks);
    expect(isTaskReady(tasks[1], statusMap)).toBe(false);
  });

  it('returns true for failed task with passed dependencies (retry)', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'passed' },
      { id: 'T2', status: 'failed', dependsOn: ['T1'] },
    ];
    const statusMap = makeStatusMap(tasks);
    expect(isTaskReady(tasks[1], statusMap)).toBe(true);
  });
});

describe('selectReadyTasks', () => {
  it('selects all ready tasks when under maxParallelTasks', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'pending' },
      { id: 'T2', status: 'pending' },
    ];
    const selected = selectReadyTasks(tasks, 5);
    expect(selected.map((t) => t.id)).toEqual(['T1', 'T2']);
  });

  it('limits selection to maxParallelTasks', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'pending' },
      { id: 'T2', status: 'pending' },
      { id: 'T3', status: 'pending' },
    ];
    const selected = selectReadyTasks(tasks, 2);
    expect(selected.map((t) => t.id)).toEqual(['T1', 'T2']);
  });

  it('returns empty array when no tasks are ready', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'passed' },
      { id: 'T2', status: 'in_progress' },
    ];
    const selected = selectReadyTasks(tasks, 5);
    expect(selected).toEqual([]);
  });

  it('respects dependencies - only selects unblocked tasks', () => {
    const tasks: Task[] = [
      { id: 'T1', status: 'pending' },
      { id: 'T2', status: 'pending', dependsOn: ['T1'] },
      { id: 'T3', status: 'pending' },
    ];
    const selected = selectReadyTasks(tasks, 5);
    expect(selected.map((t) => t.id)).toEqual(['T1', 'T3']);
  });

  describe('deterministic ordering', () => {
    it('sorts failed before pending (status rank)', () => {
      const tasks: Task[] = [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'failed' },
        { id: 'T3', status: 'pending' },
      ];
      const selected = selectReadyTasks(tasks, 5);
      expect(selected.map((t) => t.id)).toEqual(['T2', 'T1', 'T3']);
    });

    it('uses list index as secondary sort key', () => {
      const tasks: Task[] = [
        { id: 'T3', status: 'pending' },
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending' },
      ];
      const selected = selectReadyTasks(tasks, 5);
      // Should maintain list order: T3, T1, T2
      expect(selected.map((t) => t.id)).toEqual(['T3', 'T1', 'T2']);
    });

    it('uses ID lexicographic as tertiary sort key', () => {
      // This case is hard to trigger since list index breaks ties first
      // But we can verify the sort is stable for same-index scenarios
      const tasks: Task[] = [
        { id: 'A', status: 'pending' },
        { id: 'B', status: 'pending' },
        { id: 'C', status: 'pending' },
      ];
      const selected = selectReadyTasks(tasks, 5);
      expect(selected.map((t) => t.id)).toEqual(['A', 'B', 'C']);
    });

    it('applies full ordering: failed first, then index, then id', () => {
      const tasks: Task[] = [
        { id: 'T5', status: 'pending' },
        { id: 'T2', status: 'failed' },
        { id: 'T1', status: 'pending' },
        { id: 'T4', status: 'failed' },
        { id: 'T3', status: 'pending' },
      ];
      const selected = selectReadyTasks(tasks, 5);
      // Failed first (by their list index): T2 (index 1), T4 (index 3)
      // Then pending (by their list index): T5 (index 0), T1 (index 2), T3 (index 4)
      expect(selected.map((t) => t.id)).toEqual(['T2', 'T4', 'T5', 'T1', 'T3']);
    });

    it('selection is deterministic across multiple calls', () => {
      const tasks: Task[] = [
        { id: 'T3', status: 'pending' },
        { id: 'T1', status: 'failed' },
        { id: 'T2', status: 'pending' },
      ];
      const selected1 = selectReadyTasks(tasks, 2);
      const selected2 = selectReadyTasks(tasks, 2);
      const selected3 = selectReadyTasks(tasks, 2);
      expect(selected1.map((t) => t.id)).toEqual(selected2.map((t) => t.id));
      expect(selected2.map((t) => t.id)).toEqual(selected3.map((t) => t.id));
    });
  });
});

describe('scheduleReadyTasks', () => {
  it('validates and selects in one call', () => {
    const tasksFile: TasksFile = {
      schemaVersion: 1,
      tasks: [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending', dependsOn: ['T1'] },
      ],
    };
    const selected = scheduleReadyTasks(tasksFile, 5);
    expect(selected.map((t) => t.id)).toEqual(['T1']);
  });

  it('throws on validation failure', () => {
    const tasksFile: TasksFile = {
      tasks: [{ id: 'T1', status: 'pending', dependsOn: ['T2'] }],
    };
    expect(() => scheduleReadyTasks(tasksFile, 5)).toThrow(TaskSchedulerError);
  });

  it('defaults to maxParallelTasks of 1', () => {
    const tasksFile: TasksFile = {
      tasks: [
        { id: 'T1', status: 'pending' },
        { id: 'T2', status: 'pending' },
      ],
    };
    const selected = scheduleReadyTasks(tasksFile);
    expect(selected.length).toBe(1);
    expect(selected[0].id).toBe('T1');
  });

  it('handles empty tasks array', () => {
    const tasksFile: TasksFile = { tasks: [] };
    const selected = scheduleReadyTasks(tasksFile, 5);
    expect(selected).toEqual([]);
  });

  it('handles complex dependency graph', () => {
    // T1 -> T2 -> T4
    // T1 -> T3 -> T4
    // T5 (independent, failed)
    const tasksFile: TasksFile = {
      tasks: [
        { id: 'T1', status: 'passed' },
        { id: 'T2', status: 'pending', dependsOn: ['T1'] },
        { id: 'T3', status: 'pending', dependsOn: ['T1'] },
        { id: 'T4', status: 'pending', dependsOn: ['T2', 'T3'] },
        { id: 'T5', status: 'failed' },
      ],
    };
    const selected = scheduleReadyTasks(tasksFile, 3);
    // T5 (failed, no deps) should come first, then T2 and T3 (pending, deps satisfied)
    expect(selected.map((t) => t.id)).toEqual(['T5', 'T2', 'T3']);
  });
});
