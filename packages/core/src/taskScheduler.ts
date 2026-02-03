/**
 * Deterministic task dependency scheduler for parallel task execution.
 *
 * This module implements §6.2.2 of the parallel execution design (Issue #78):
 * - DAG validation: unique task IDs, valid dependsOn references, cycle detection
 * - Ready-task computation: tasks with status "pending" or "failed" whose dependencies are all "passed"
 * - Deterministic selection: sorted by status rank (failed before pending), list index, then ID lexicographic
 */

/** Valid task statuses */
export type TaskStatus = 'pending' | 'in_progress' | 'passed' | 'failed';

/** Task definition from .jeeves/tasks.json */
export interface Task {
  id: string;
  title?: string;
  summary?: string;
  acceptanceCriteria?: string[];
  filesAllowed?: string[];
  dependsOn?: string[];
  status: TaskStatus;
}

/** Tasks file structure */
export interface TasksFile {
  schemaVersion?: number;
  decomposedFrom?: string;
  tasks: Task[];
}

/** Error type for scheduler validation failures */
export class TaskSchedulerError extends Error {
  constructor(
    message: string,
    public readonly code: 'DUPLICATE_ID' | 'MISSING_DEPENDENCY' | 'CYCLE_DETECTED',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TaskSchedulerError';
  }
}

/**
 * Validates that all task IDs are unique.
 * @throws TaskSchedulerError with code DUPLICATE_ID if duplicates found
 */
function validateUniqueIds(tasks: readonly Task[]): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    if (seen.has(task.id)) {
      throw new TaskSchedulerError(
        `Duplicate task ID '${task.id}' found at indices ${seen.get(task.id)} and ${i}`,
        'DUPLICATE_ID',
        { taskId: task.id, firstIndex: seen.get(task.id), secondIndex: i },
      );
    }
    seen.set(task.id, i);
  }
}

/**
 * Validates that all dependsOn entries reference existing task IDs.
 * @throws TaskSchedulerError with code MISSING_DEPENDENCY if invalid reference found
 */
function validateDependencyReferences(tasks: readonly Task[]): void {
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    const deps = task.dependsOn ?? [];
    for (const depId of deps) {
      if (!taskIds.has(depId)) {
        throw new TaskSchedulerError(
          `Task '${task.id}' depends on non-existent task '${depId}'`,
          'MISSING_DEPENDENCY',
          { taskId: task.id, missingDependency: depId },
        );
      }
    }
  }
}

/**
 * Detects cycles in the dependency graph using DFS.
 * @throws TaskSchedulerError with code CYCLE_DETECTED if cycle found
 */
function detectCycles(tasks: readonly Task[]): void {
  const taskMap = new Map<string, Task>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // States: 0 = unvisited, 1 = visiting (in current path), 2 = visited
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];

  function dfs(taskId: string): void {
    const currentState = state.get(taskId) ?? 0;
    if (currentState === 2) return; // Already fully explored
    if (currentState === 1) {
      // Found cycle - extract cycle path
      const cycleStart = path.indexOf(taskId);
      const cyclePath = [...path.slice(cycleStart), taskId];
      throw new TaskSchedulerError(
        `Cycle detected in task dependencies: ${cyclePath.join(' -> ')}`,
        'CYCLE_DETECTED',
        { cycle: cyclePath },
      );
    }

    state.set(taskId, 1);
    path.push(taskId);

    const task = taskMap.get(taskId);
    if (task) {
      const deps = task.dependsOn ?? [];
      for (const depId of deps) {
        dfs(depId);
      }
    }

    path.pop();
    state.set(taskId, 2);
  }

  // Visit all nodes
  for (const task of tasks) {
    dfs(task.id);
  }
}

/**
 * Validates the task dependency graph.
 *
 * Validation rules (per §6.2.2):
 * 1. Task IDs are unique
 * 2. dependsOn entries reference existing task IDs
 * 3. Dependency graph is acyclic (no cycles)
 *
 * @param tasks Array of tasks to validate
 * @throws TaskSchedulerError if validation fails
 */
export function validateTaskGraph(tasks: readonly Task[]): void {
  validateUniqueIds(tasks);
  validateDependencyReferences(tasks);
  detectCycles(tasks);
}

/**
 * Determines if a task is ready to be scheduled.
 *
 * A task is "ready to implement" iff (per §6.2.2):
 * - task.status is "pending" or "failed" (both are retryable)
 * - AND for every depId in dependsOn, the referenced task has status === "passed"
 *
 * Tasks with status "in_progress" are NOT schedulable.
 *
 * @param task The task to check
 * @param taskStatusMap Map of task ID to current status
 * @returns true if the task is ready to be scheduled
 */
export function isTaskReady(task: Task, taskStatusMap: Map<string, TaskStatus>): boolean {
  // Only pending or failed tasks can be scheduled
  if (task.status !== 'pending' && task.status !== 'failed') {
    return false;
  }

  // Check all dependencies are passed
  const deps = task.dependsOn ?? [];
  for (const depId of deps) {
    const depStatus = taskStatusMap.get(depId);
    if (depStatus !== 'passed') {
      return false;
    }
  }

  return true;
}

/**
 * Selects ready tasks for parallel execution.
 *
 * Selection rules (per §6.2.2, deterministic ordering):
 * 1. Build the ready list by filtering tasks with the "ready to implement" predicate
 * 2. Sort the ready list by:
 *    - task.status rank: "failed" before "pending"
 *    - task list index in tasks array (ascending)
 *    - task.id lexicographic ascending (strict, locale-independent string compare)
 * 3. Select the first maxParallelTasks tasks in that sorted order
 *
 * @param tasks Array of all tasks
 * @param maxParallelTasks Maximum number of tasks to select
 * @returns Array of selected tasks (up to maxParallelTasks)
 */
export function selectReadyTasks(tasks: readonly Task[], maxParallelTasks: number): Task[] {
  // Build task status map for dependency checking
  const taskStatusMap = new Map<string, TaskStatus>();
  for (const task of tasks) {
    taskStatusMap.set(task.id, task.status);
  }

  // Build task index map for stable sorting
  const taskIndexMap = new Map<string, number>();
  for (let i = 0; i < tasks.length; i += 1) {
    taskIndexMap.set(tasks[i].id, i);
  }

  // Filter to ready tasks
  const readyTasks = tasks.filter((task) => isTaskReady(task, taskStatusMap));

  // Sort by deterministic ordering (per §6.2.2):
  // 1. status rank: "failed" before "pending"
  // 2. list index (ascending)
  // 3. id lexicographic ascending (strict, locale-independent)
  readyTasks.sort((a, b) => {
    // Status rank: failed (0) before pending (1)
    const statusRank = (s: TaskStatus): number => (s === 'failed' ? 0 : 1);
    const statusDiff = statusRank(a.status) - statusRank(b.status);
    if (statusDiff !== 0) return statusDiff;

    // List index (ascending)
    const indexA = taskIndexMap.get(a.id) ?? 0;
    const indexB = taskIndexMap.get(b.id) ?? 0;
    const indexDiff = indexA - indexB;
    if (indexDiff !== 0) return indexDiff;

    // ID lexicographic ascending (strict, locale-independent)
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  // Select up to maxParallelTasks
  return readyTasks.slice(0, Math.max(0, maxParallelTasks));
}

/**
 * Main entry point: validate task graph and select ready tasks.
 *
 * @param tasksFile The tasks file content
 * @param maxParallelTasks Maximum number of tasks to select (default: 1)
 * @returns Array of selected tasks
 * @throws TaskSchedulerError if validation fails
 */
export function scheduleReadyTasks(tasksFile: TasksFile, maxParallelTasks = 1): Task[] {
  const tasks = tasksFile.tasks;
  validateTaskGraph(tasks);
  return selectReadyTasks(tasks, maxParallelTasks);
}
