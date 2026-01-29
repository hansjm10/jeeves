# src/jeeves/core/tasks.py
"""Task management for decomposed implementation workflow.

This module handles task decomposition, where a design document is broken
into small, scoped tasks that can be implemented with fresh context.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class Task:
    """A single implementation task.

    Attributes:
        id: Unique task identifier (e.g., "T1", "T2")
        title: Short descriptive title
        summary: What this task accomplishes
        acceptanceCriteria: Verifiable criteria for task completion
        filesAllowed: Glob patterns for files this task may modify
        dependsOn: Task IDs that must complete first (for ordering)
        status: One of: pending, in_progress, passed, failed
    """

    id: str
    title: str
    summary: str
    acceptanceCriteria: List[str]
    filesAllowed: List[str] = field(default_factory=list)
    dependsOn: List[str] = field(default_factory=list)
    status: str = "pending"  # pending, in_progress, passed, failed

    def to_dict(self) -> Dict[str, Any]:
        """Convert task to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "acceptanceCriteria": self.acceptanceCriteria,
            "filesAllowed": self.filesAllowed,
            "dependsOn": self.dependsOn,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Task":
        """Create a Task from a dictionary."""
        return cls(
            id=data["id"],
            title=data["title"],
            summary=data["summary"],
            acceptanceCriteria=data.get("acceptanceCriteria", []),
            filesAllowed=data.get("filesAllowed", []),
            dependsOn=data.get("dependsOn", []),
            status=data.get("status", "pending"),
        )


@dataclass
class TaskList:
    """A list of tasks extracted from a design document.

    Attributes:
        schemaVersion: Schema version for future migrations (always 1)
        decomposedFrom: Path to design document this was extracted from
        tasks: Ordered list of tasks to implement
    """

    schemaVersion: int
    decomposedFrom: str
    tasks: List[Task]

    def to_dict(self) -> Dict[str, Any]:
        """Convert task list to dictionary for JSON serialization."""
        return {
            "schemaVersion": self.schemaVersion,
            "decomposedFrom": self.decomposedFrom,
            "tasks": [t.to_dict() for t in self.tasks],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TaskList":
        """Create a TaskList from a dictionary."""
        return cls(
            schemaVersion=data.get("schemaVersion", 1),
            decomposedFrom=data.get("decomposedFrom", ""),
            tasks=[Task.from_dict(t) for t in data.get("tasks", [])],
        )


def load_tasks(path: Path) -> TaskList:
    """Load tasks from a JSON file.

    Args:
        path: Path to the tasks.json file

    Returns:
        TaskList loaded from the file

    Raises:
        FileNotFoundError: If the file does not exist
        json.JSONDecodeError: If the file contains invalid JSON
    """
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return TaskList.from_dict(data)


def save_tasks(task_list: TaskList, path: Path) -> None:
    """Save tasks to a JSON file.

    Args:
        task_list: TaskList to save
        path: Path to write the tasks.json file
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(task_list.to_dict(), f, indent=2)
        f.write("\n")


def get_current_task(task_list: TaskList) -> Optional[Task]:
    """Get the current task (first pending or in_progress task).

    Args:
        task_list: TaskList to search

    Returns:
        The first task with status pending or in_progress, or None if all complete
    """
    for task in task_list.tasks:
        if task.status in ("pending", "in_progress"):
            return task
    return None


def get_task_by_id(task_list: TaskList, task_id: str) -> Optional[Task]:
    """Get a task by its ID.

    Args:
        task_list: TaskList to search
        task_id: Task ID to find

    Returns:
        The task with the given ID, or None if not found
    """
    for task in task_list.tasks:
        if task.id == task_id:
            return task
    return None


def advance_task(task_list: TaskList, task_id: str, passed: bool) -> bool:
    """Mark a task as passed/failed and check if more tasks remain.

    Args:
        task_list: TaskList to update
        task_id: ID of task to update
        passed: True if task passed, False if failed

    Returns:
        True if there are more pending tasks, False if all complete or task not found
    """
    task = get_task_by_id(task_list, task_id)
    if task is None:
        return False

    task.status = "passed" if passed else "failed"

    # Check if there are more pending tasks
    next_task = get_current_task(task_list)
    return next_task is not None


def all_tasks_complete(task_list: TaskList) -> bool:
    """Check if all tasks have passed.

    Args:
        task_list: TaskList to check

    Returns:
        True if all tasks have status "passed"
    """
    return all(t.status == "passed" for t in task_list.tasks)


def get_pending_task_count(task_list: TaskList) -> int:
    """Get count of tasks not yet passed.

    Args:
        task_list: TaskList to count

    Returns:
        Number of tasks with status other than "passed"
    """
    return sum(1 for t in task_list.tasks if t.status != "passed")
