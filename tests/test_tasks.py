# tests/test_tasks.py
"""Tests for task management module."""

import json
import pytest
from pathlib import Path


class TestTask:
    """Tests for Task dataclass."""

    def test_task_creation_with_required_fields(self):
        """Should create a Task with required fields."""
        from jeeves.core.tasks import Task

        task = Task(
            id="T1",
            title="Test task",
            summary="A test task",
            acceptanceCriteria=["Criterion 1", "Criterion 2"],
        )

        assert task.id == "T1"
        assert task.title == "Test task"
        assert task.summary == "A test task"
        assert task.acceptanceCriteria == ["Criterion 1", "Criterion 2"]
        assert task.filesAllowed == []
        assert task.dependsOn == []
        assert task.status == "pending"

    def test_task_creation_with_all_fields(self):
        """Should create a Task with all fields specified."""
        from jeeves.core.tasks import Task

        task = Task(
            id="T2",
            title="Full task",
            summary="A complete task",
            acceptanceCriteria=["Test passes"],
            filesAllowed=["src/*.py"],
            dependsOn=["T1"],
            status="in_progress",
        )

        assert task.id == "T2"
        assert task.filesAllowed == ["src/*.py"]
        assert task.dependsOn == ["T1"]
        assert task.status == "in_progress"

    def test_task_to_dict(self):
        """Should convert Task to dictionary."""
        from jeeves.core.tasks import Task

        task = Task(
            id="T1",
            title="Test task",
            summary="A test task",
            acceptanceCriteria=["Criterion 1"],
            filesAllowed=["src/*.py"],
            dependsOn=["T0"],
            status="passed",
        )

        result = task.to_dict()

        assert result == {
            "id": "T1",
            "title": "Test task",
            "summary": "A test task",
            "acceptanceCriteria": ["Criterion 1"],
            "filesAllowed": ["src/*.py"],
            "dependsOn": ["T0"],
            "status": "passed",
        }

    def test_task_from_dict(self):
        """Should create Task from dictionary."""
        from jeeves.core.tasks import Task

        data = {
            "id": "T3",
            "title": "From dict task",
            "summary": "Created from dict",
            "acceptanceCriteria": ["A", "B"],
            "filesAllowed": ["tests/*.py"],
            "dependsOn": ["T1", "T2"],
            "status": "failed",
        }

        task = Task.from_dict(data)

        assert task.id == "T3"
        assert task.title == "From dict task"
        assert task.summary == "Created from dict"
        assert task.acceptanceCriteria == ["A", "B"]
        assert task.filesAllowed == ["tests/*.py"]
        assert task.dependsOn == ["T1", "T2"]
        assert task.status == "failed"

    def test_task_from_dict_with_missing_optional_fields(self):
        """Should use defaults for missing optional fields."""
        from jeeves.core.tasks import Task

        data = {
            "id": "T1",
            "title": "Minimal",
            "summary": "Minimal task",
        }

        task = Task.from_dict(data)

        assert task.acceptanceCriteria == []
        assert task.filesAllowed == []
        assert task.dependsOn == []
        assert task.status == "pending"

    def test_task_roundtrip(self):
        """Should survive to_dict/from_dict roundtrip."""
        from jeeves.core.tasks import Task

        original = Task(
            id="T5",
            title="Roundtrip test",
            summary="Testing roundtrip",
            acceptanceCriteria=["Test 1", "Test 2"],
            filesAllowed=["**/*.py"],
            dependsOn=["T3", "T4"],
            status="in_progress",
        )

        roundtripped = Task.from_dict(original.to_dict())

        assert roundtripped.id == original.id
        assert roundtripped.title == original.title
        assert roundtripped.summary == original.summary
        assert roundtripped.acceptanceCriteria == original.acceptanceCriteria
        assert roundtripped.filesAllowed == original.filesAllowed
        assert roundtripped.dependsOn == original.dependsOn
        assert roundtripped.status == original.status


class TestTaskList:
    """Tests for TaskList dataclass."""

    def test_tasklist_creation(self):
        """Should create a TaskList with required fields."""
        from jeeves.core.tasks import Task, TaskList

        tasks = [
            Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=["A"]),
            Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=["B"]),
        ]

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="docs/design.md",
            tasks=tasks,
        )

        assert task_list.schemaVersion == 1
        assert task_list.decomposedFrom == "docs/design.md"
        assert len(task_list.tasks) == 2
        assert task_list.tasks[0].id == "T1"

    def test_tasklist_to_dict(self):
        """Should convert TaskList to dictionary."""
        from jeeves.core.tasks import Task, TaskList

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="docs/test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=["A"]),
            ],
        )

        result = task_list.to_dict()

        assert result["schemaVersion"] == 1
        assert result["decomposedFrom"] == "docs/test.md"
        assert len(result["tasks"]) == 1
        assert result["tasks"][0]["id"] == "T1"

    def test_tasklist_from_dict(self):
        """Should create TaskList from dictionary."""
        from jeeves.core.tasks import TaskList

        data = {
            "schemaVersion": 1,
            "decomposedFrom": "docs/design.md",
            "tasks": [
                {
                    "id": "T1",
                    "title": "Task 1",
                    "summary": "First task",
                    "acceptanceCriteria": ["Done"],
                    "status": "passed",
                },
                {
                    "id": "T2",
                    "title": "Task 2",
                    "summary": "Second task",
                    "acceptanceCriteria": ["Also done"],
                    "status": "pending",
                },
            ],
        }

        task_list = TaskList.from_dict(data)

        assert task_list.schemaVersion == 1
        assert task_list.decomposedFrom == "docs/design.md"
        assert len(task_list.tasks) == 2
        assert task_list.tasks[0].title == "Task 1"
        assert task_list.tasks[1].status == "pending"

    def test_tasklist_from_dict_with_defaults(self):
        """Should use defaults for missing fields."""
        from jeeves.core.tasks import TaskList

        data = {}

        task_list = TaskList.from_dict(data)

        assert task_list.schemaVersion == 1
        assert task_list.decomposedFrom == ""
        assert task_list.tasks == []

    def test_tasklist_roundtrip(self):
        """Should survive to_dict/from_dict roundtrip."""
        from jeeves.core.tasks import Task, TaskList

        original = TaskList(
            schemaVersion=1,
            decomposedFrom="docs/original.md",
            tasks=[
                Task(
                    id="T1",
                    title="Task 1",
                    summary="First",
                    acceptanceCriteria=["A", "B"],
                    filesAllowed=["src/*.py"],
                    status="passed",
                ),
                Task(
                    id="T2",
                    title="Task 2",
                    summary="Second",
                    acceptanceCriteria=["C"],
                    dependsOn=["T1"],
                    status="pending",
                ),
            ],
        )

        roundtripped = TaskList.from_dict(original.to_dict())

        assert roundtripped.schemaVersion == original.schemaVersion
        assert roundtripped.decomposedFrom == original.decomposedFrom
        assert len(roundtripped.tasks) == len(original.tasks)
        assert roundtripped.tasks[0].id == original.tasks[0].id
        assert roundtripped.tasks[1].dependsOn == original.tasks[1].dependsOn


class TestLoadAndSaveTasks:
    """Tests for load_tasks and save_tasks functions."""

    def test_save_tasks_creates_file(self, tmp_path):
        """Should save TaskList to a JSON file."""
        from jeeves.core.tasks import Task, TaskList, save_tasks

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="docs/test.md",
            tasks=[
                Task(id="T1", title="Test", summary="Test task", acceptanceCriteria=["Pass"]),
            ],
        )

        file_path = tmp_path / "tasks.json"
        save_tasks(task_list, file_path)

        assert file_path.exists()
        with open(file_path) as f:
            data = json.load(f)
        assert data["schemaVersion"] == 1
        assert data["tasks"][0]["id"] == "T1"

    def test_save_tasks_creates_parent_directories(self, tmp_path):
        """Should create parent directories if they don't exist."""
        from jeeves.core.tasks import Task, TaskList, save_tasks

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Test", summary="Test", acceptanceCriteria=[]),
            ],
        )

        file_path = tmp_path / "nested" / "dir" / "tasks.json"
        save_tasks(task_list, file_path)

        assert file_path.exists()

    def test_load_tasks_reads_file(self, tmp_path):
        """Should load TaskList from a JSON file."""
        from jeeves.core.tasks import load_tasks

        data = {
            "schemaVersion": 1,
            "decomposedFrom": "docs/design.md",
            "tasks": [
                {
                    "id": "T1",
                    "title": "Loaded task",
                    "summary": "From file",
                    "acceptanceCriteria": ["Works"],
                    "status": "pending",
                },
            ],
        }

        file_path = tmp_path / "tasks.json"
        with open(file_path, "w") as f:
            json.dump(data, f)

        task_list = load_tasks(file_path)

        assert task_list.schemaVersion == 1
        assert task_list.decomposedFrom == "docs/design.md"
        assert len(task_list.tasks) == 1
        assert task_list.tasks[0].title == "Loaded task"

    def test_load_tasks_raises_on_missing_file(self, tmp_path):
        """Should raise FileNotFoundError for missing file."""
        from jeeves.core.tasks import load_tasks

        with pytest.raises(FileNotFoundError):
            load_tasks(tmp_path / "nonexistent.json")

    def test_load_tasks_raises_on_invalid_json(self, tmp_path):
        """Should raise JSONDecodeError for invalid JSON."""
        from jeeves.core.tasks import load_tasks

        file_path = tmp_path / "invalid.json"
        with open(file_path, "w") as f:
            f.write("not valid json {")

        with pytest.raises(json.JSONDecodeError):
            load_tasks(file_path)

    def test_save_and_load_roundtrip(self, tmp_path):
        """Should survive save/load roundtrip."""
        from jeeves.core.tasks import Task, TaskList, save_tasks, load_tasks

        original = TaskList(
            schemaVersion=1,
            decomposedFrom="docs/roundtrip.md",
            tasks=[
                Task(
                    id="T1",
                    title="Task 1",
                    summary="First",
                    acceptanceCriteria=["A", "B"],
                    filesAllowed=["src/*.py"],
                    status="passed",
                ),
                Task(
                    id="T2",
                    title="Task 2",
                    summary="Second",
                    acceptanceCriteria=["C"],
                    dependsOn=["T1"],
                    status="in_progress",
                ),
            ],
        )

        file_path = tmp_path / "tasks.json"
        save_tasks(original, file_path)
        loaded = load_tasks(file_path)

        assert loaded.schemaVersion == original.schemaVersion
        assert loaded.decomposedFrom == original.decomposedFrom
        assert len(loaded.tasks) == len(original.tasks)
        assert loaded.tasks[0].id == original.tasks[0].id
        assert loaded.tasks[1].status == original.tasks[1].status


class TestGetCurrentTask:
    """Tests for get_current_task function."""

    def test_returns_first_pending_task(self):
        """Should return the first task with pending status."""
        from jeeves.core.tasks import Task, TaskList, get_current_task

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
                Task(id="T3", title="Task 3", summary="Third", acceptanceCriteria=[], status="pending"),
            ],
        )

        current = get_current_task(task_list)

        assert current is not None
        assert current.id == "T2"

    def test_returns_in_progress_task(self):
        """Should return in_progress task over pending."""
        from jeeves.core.tasks import Task, TaskList, get_current_task

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="in_progress"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
            ],
        )

        current = get_current_task(task_list)

        assert current is not None
        assert current.id == "T1"

    def test_returns_none_when_all_passed(self):
        """Should return None when all tasks have passed."""
        from jeeves.core.tasks import Task, TaskList, get_current_task

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="passed"),
            ],
        )

        current = get_current_task(task_list)

        assert current is None

    def test_returns_none_for_empty_task_list(self):
        """Should return None for empty task list."""
        from jeeves.core.tasks import TaskList, get_current_task

        task_list = TaskList(schemaVersion=1, decomposedFrom="test.md", tasks=[])

        current = get_current_task(task_list)

        assert current is None

    def test_skips_failed_tasks(self):
        """Should skip failed tasks and return next pending."""
        from jeeves.core.tasks import Task, TaskList, get_current_task

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="failed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
            ],
        )

        current = get_current_task(task_list)

        # Note: failed tasks are NOT skipped by get_current_task - they need retry
        # The design says in_progress or pending, not failed
        assert current is not None
        assert current.id == "T2"


class TestGetTaskById:
    """Tests for get_task_by_id function."""

    def test_returns_task_when_found(self):
        """Should return task matching the given ID."""
        from jeeves.core.tasks import Task, TaskList, get_task_by_id

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[]),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[]),
                Task(id="T3", title="Task 3", summary="Third", acceptanceCriteria=[]),
            ],
        )

        task = get_task_by_id(task_list, "T2")

        assert task is not None
        assert task.id == "T2"
        assert task.title == "Task 2"

    def test_returns_none_when_not_found(self):
        """Should return None when task ID doesn't exist."""
        from jeeves.core.tasks import Task, TaskList, get_task_by_id

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[]),
            ],
        )

        task = get_task_by_id(task_list, "T99")

        assert task is None

    def test_returns_none_for_empty_list(self):
        """Should return None for empty task list."""
        from jeeves.core.tasks import TaskList, get_task_by_id

        task_list = TaskList(schemaVersion=1, decomposedFrom="test.md", tasks=[])

        task = get_task_by_id(task_list, "T1")

        assert task is None


class TestAdvanceTask:
    """Tests for advance_task function."""

    def test_marks_task_as_passed(self):
        """Should set task status to passed when passed=True."""
        from jeeves.core.tasks import Task, TaskList, advance_task, get_task_by_id

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="in_progress"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
            ],
        )

        advance_task(task_list, "T1", passed=True)

        task = get_task_by_id(task_list, "T1")
        assert task is not None
        assert task.status == "passed"

    def test_marks_task_as_failed(self):
        """Should set task status to failed when passed=False."""
        from jeeves.core.tasks import Task, TaskList, advance_task, get_task_by_id

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="in_progress"),
            ],
        )

        advance_task(task_list, "T1", passed=False)

        task = get_task_by_id(task_list, "T1")
        assert task is not None
        assert task.status == "failed"

    def test_returns_true_when_more_tasks_remain(self):
        """Should return True when there are more pending tasks."""
        from jeeves.core.tasks import Task, TaskList, advance_task

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="in_progress"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
            ],
        )

        result = advance_task(task_list, "T1", passed=True)

        assert result is True

    def test_returns_false_when_all_complete(self):
        """Should return False when no more pending tasks remain."""
        from jeeves.core.tasks import Task, TaskList, advance_task

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="in_progress"),
            ],
        )

        result = advance_task(task_list, "T1", passed=True)

        assert result is False

    def test_returns_false_for_nonexistent_task(self):
        """Should return False when task ID doesn't exist."""
        from jeeves.core.tasks import Task, TaskList, advance_task

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[]),
            ],
        )

        result = advance_task(task_list, "T99", passed=True)

        assert result is False


class TestAllTasksComplete:
    """Tests for all_tasks_complete function."""

    def test_returns_true_when_all_passed(self):
        """Should return True when all tasks have passed status."""
        from jeeves.core.tasks import Task, TaskList, all_tasks_complete

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="passed"),
            ],
        )

        assert all_tasks_complete(task_list) is True

    def test_returns_false_when_pending_exists(self):
        """Should return False when any task is pending."""
        from jeeves.core.tasks import Task, TaskList, all_tasks_complete

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
            ],
        )

        assert all_tasks_complete(task_list) is False

    def test_returns_false_when_in_progress_exists(self):
        """Should return False when any task is in_progress."""
        from jeeves.core.tasks import Task, TaskList, all_tasks_complete

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="in_progress"),
            ],
        )

        assert all_tasks_complete(task_list) is False

    def test_returns_false_when_failed_exists(self):
        """Should return False when any task is failed."""
        from jeeves.core.tasks import Task, TaskList, all_tasks_complete

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="failed"),
            ],
        )

        assert all_tasks_complete(task_list) is False

    def test_returns_true_for_empty_list(self):
        """Should return True for empty task list (vacuously true)."""
        from jeeves.core.tasks import TaskList, all_tasks_complete

        task_list = TaskList(schemaVersion=1, decomposedFrom="test.md", tasks=[])

        assert all_tasks_complete(task_list) is True


class TestGetPendingTaskCount:
    """Tests for get_pending_task_count function."""

    def test_counts_non_passed_tasks(self):
        """Should count tasks that don't have passed status."""
        from jeeves.core.tasks import Task, TaskList, get_pending_task_count

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
                Task(id="T3", title="Task 3", summary="Third", acceptanceCriteria=[], status="in_progress"),
                Task(id="T4", title="Task 4", summary="Fourth", acceptanceCriteria=[], status="failed"),
            ],
        )

        count = get_pending_task_count(task_list)

        assert count == 3  # pending, in_progress, and failed

    def test_returns_zero_when_all_passed(self):
        """Should return 0 when all tasks are passed."""
        from jeeves.core.tasks import Task, TaskList, get_pending_task_count

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="passed"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="passed"),
            ],
        )

        count = get_pending_task_count(task_list)

        assert count == 0

    def test_returns_total_for_all_pending(self):
        """Should return total count when all tasks are pending."""
        from jeeves.core.tasks import Task, TaskList, get_pending_task_count

        task_list = TaskList(
            schemaVersion=1,
            decomposedFrom="test.md",
            tasks=[
                Task(id="T1", title="Task 1", summary="First", acceptanceCriteria=[], status="pending"),
                Task(id="T2", title="Task 2", summary="Second", acceptanceCriteria=[], status="pending"),
                Task(id="T3", title="Task 3", summary="Third", acceptanceCriteria=[], status="pending"),
            ],
        )

        count = get_pending_task_count(task_list)

        assert count == 3

    def test_returns_zero_for_empty_list(self):
        """Should return 0 for empty task list."""
        from jeeves.core.tasks import TaskList, get_pending_task_count

        task_list = TaskList(schemaVersion=1, decomposedFrom="test.md", tasks=[])

        count = get_pending_task_count(task_list)

        assert count == 0
