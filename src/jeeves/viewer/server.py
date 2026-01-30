#!/usr/bin/env python3
"""
Jeeves Real-time Viewer - A beautiful web dashboard for monitoring Jeeves agent runs

Features:
- Real-time log streaming via SSE with file watching
- Proper state tracking from issue.json/prd.json
- Responsive design inspired by GitHub's UI
"""

import argparse
import json
import os
import signal
import sys
import time
import copy
import re

# Add src directory to path so we can import the jeeves package
# when running this script directly (e.g., ./src/jeeves/viewer/server.py)
_viewer_dir = os.path.dirname(os.path.abspath(__file__))
_jeeves_dir = os.path.dirname(_viewer_dir)  # src/jeeves
_src_dir = os.path.dirname(_jeeves_dir)     # src/
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
try:
    # Python 3.7+
    from http.server import ThreadingHTTPServer
except ImportError:  # pragma: no cover (py36 fallback)
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
from pathlib import Path
from threading import Thread, Lock
from typing import Dict, Optional, List, Tuple
from urllib.parse import parse_qs, urlparse
import select
import subprocess
from queue import Queue, Empty

# Import jeeves.core modules for the new src/ layout
from jeeves.core.paths import (
    get_data_dir,
    get_issue_state_dir,
    get_worktree_path,
    parse_issue_ref,
    parse_repo_spec,
)
from jeeves.core.issue import (
    IssueError,
    IssueState,
    create_issue_state,
    list_issues as list_issues_from_jeeves,
)
from jeeves.core.repo import ensure_repo, RepoError
from jeeves.core.worktree import create_worktree, WorktreeError, _create_state_symlink
from jeeves.core.workflow import PhaseType
from jeeves.core.workflow_loader import load_workflow_by_name, WorkflowValidationError, load_workflow
from jeeves.core.engine import WorkflowEngine
import yaml
from jeeves.core.script_runner import run_script_phase


def _get_active_issue_file() -> Path:
    """Get the path to the active issue config file."""
    return get_data_dir() / "active-issue.json"


def save_active_issue(issue_ref: str) -> None:
    """Save the active issue reference to persistent storage."""
    config_file = _get_active_issue_file()
    config_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(config_file, "w") as f:
            json.dump({"issue_ref": issue_ref, "saved_at": datetime.now().isoformat()}, f)
    except OSError:
        pass  # Non-critical - don't fail if we can't save


def load_active_issue() -> Optional[str]:
    """Load the active issue reference from persistent storage."""
    config_file = _get_active_issue_file()
    if not config_file.exists():
        return None
    try:
        with open(config_file, "r") as f:
            data = json.load(f)
        return data.get("issue_ref")
    except (OSError, json.JSONDecodeError):
        return None


def resolve_prompt_path(phase: str, prompts_dir: Path, engine: WorkflowEngine) -> Path:
    """Resolve the prompt file path for a phase using the workflow engine."""
    if engine.is_terminal(phase):
        raise ValueError("Phase is complete; no prompt to run.")

    prompt_name = engine.get_prompt_for_phase(phase)
    if not prompt_name:
        raise ValueError(f"No prompt defined for phase: {phase}")

    prompt_path = (prompts_dir / prompt_name).resolve()
    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt not found: {prompt_path}")
    return prompt_path


class JeevesWorkflowManager:
    """Read/write Jeeves workflow definitions from workflows/ directory."""

    # Known status fields for autocomplete in guard expressions
    KNOWN_STATUS_FIELDS = [
        "designApproved",
        "designNeedsChanges",
        "designDraftComplete",
        "taskDecompositionComplete",
        "currentTaskId",
        "taskPassed",
        "taskFailed",
        "hasMoreTasks",
        "allTasksComplete",
        "commitFailed",
        "pushFailed",
        "missingWork",
        "implementationComplete",
        "prCreated",
        "reviewNeedsChanges",
        "reviewClean",
    ]

    def __init__(self, workflows_dir: Path):
        self.workflows_dir = workflows_dir.resolve()
        self._lock = Lock()

    def _resolve_workflow_name(self, name: str) -> Path:
        """Resolve workflow name to file path with path traversal prevention."""
        if not isinstance(name, str) or not name:
            raise ValueError("workflow name is required")
        if "/" in name or "\\" in name or ".." in name:
            raise ValueError("invalid workflow name")
        if not name.endswith(".yaml"):
            name = f"{name}.yaml"

        path = (self.workflows_dir / name).resolve()
        try:
            path.relative_to(self.workflows_dir)
        except ValueError as e:
            raise ValueError("invalid workflow name") from e

        return path

    def list_workflows(self) -> List[Dict]:
        """List all workflow files in the workflows directory."""
        workflows: List[Dict] = []
        try:
            for path in sorted(self.workflows_dir.glob("*.yaml")):
                if not path.is_file():
                    continue
                stat = path.stat()
                workflows.append({
                    "name": path.stem,
                    "path": str(path),
                    "mtime": stat.st_mtime,
                    "size": stat.st_size,
                })
        except Exception:
            return []
        return workflows

    def get_workflow_full(self, name: str) -> Dict:
        """Get complete workflow definition as JSON."""
        path = self._resolve_workflow_name(name)
        if not path.exists():
            raise FileNotFoundError(f"Workflow not found: {name}")

        try:
            workflow = load_workflow(path)
        except Exception as e:
            raise RuntimeError(f"Failed to load workflow: {e}") from e

        # Convert to JSON-serializable format
        phases = {}
        for phase_name, phase in workflow.phases.items():
            phase_data = {
                "name": phase_name,
                "type": phase.type.value,
                "description": phase.description or "",
                "transitions": [
                    {
                        "to": t.to,
                        "when": t.when,
                        "auto": t.auto,
                        "priority": t.priority,
                    }
                    for t in phase.transitions
                ],
            }
            if phase.prompt:
                phase_data["prompt"] = phase.prompt
            if phase.command:
                phase_data["command"] = phase.command
            if phase.allowed_writes and phase.allowed_writes != [".jeeves/*"]:
                phase_data["allowed_writes"] = phase.allowed_writes
            if phase.model:
                phase_data["model"] = phase.model
            phases[phase_name] = phase_data

        workflow_data = {
            "name": workflow.name,
            "version": workflow.version,
            "start": workflow.start,
        }
        if workflow.default_model:
            workflow_data["default_model"] = workflow.default_model

        return {
            "workflow": workflow_data,
            "phases": phases,
        }

    def save_workflow(self, name: str, data: Dict) -> None:
        """Save workflow definition to YAML file."""
        path = self._resolve_workflow_name(name)

        # Validate the workflow data first
        errors = self.validate_workflow(data)
        if errors:
            raise ValueError(f"Workflow validation failed: {'; '.join(errors)}")

        # Convert JSON format to YAML format
        workflow_section = data.get("workflow", {"name": name, "version": 1, "start": "design_draft"})
        # Add default_model to workflow section if present
        if data.get("workflow", {}).get("default_model"):
            workflow_section["default_model"] = data["workflow"]["default_model"]
        yaml_data = {
            "workflow": workflow_section,
            "phases": {},
        }

        phases = data.get("phases", {})
        for phase_name, phase in phases.items():
            phase_yaml = {"type": phase.get("type", "execute")}

            if phase.get("description"):
                phase_yaml["description"] = phase["description"]
            if phase.get("prompt"):
                phase_yaml["prompt"] = phase["prompt"]
            if phase.get("command"):
                phase_yaml["command"] = phase["command"]
            if phase.get("allowed_writes"):
                phase_yaml["allowed_writes"] = phase["allowed_writes"]
            if phase.get("model"):
                phase_yaml["model"] = phase["model"]

            transitions = phase.get("transitions", [])
            if transitions:
                phase_yaml["transitions"] = []
                for t in transitions:
                    t_yaml = {"to": t["to"]}
                    if t.get("when"):
                        t_yaml["when"] = t["when"]
                    if t.get("auto"):
                        t_yaml["auto"] = t["auto"]
                    if t.get("priority", 0) != 0:
                        t_yaml["priority"] = t["priority"]
                    phase_yaml["transitions"].append(t_yaml)

            yaml_data["phases"][phase_name] = phase_yaml

        tmp_path = path.with_suffix(path.suffix + ".tmp")

        with self._lock:
            try:
                with open(tmp_path, "w", encoding="utf-8") as f:
                    yaml.dump(yaml_data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
                tmp_path.replace(path)
            finally:
                try:
                    tmp_path.unlink()
                except Exception:
                    pass

    def validate_workflow(self, data: Dict) -> List[str]:
        """Validate workflow structure without saving. Returns list of error messages."""
        errors: List[str] = []

        workflow = data.get("workflow", {})
        phases = data.get("phases", {})

        if not phases:
            errors.append("Workflow has no phases")
            return errors

        start = workflow.get("start", "")
        if not start:
            errors.append("Workflow has no start phase defined")
        elif start not in phases:
            errors.append(f"Start phase '{start}' not found in workflow phases")

        # Check all transition targets exist
        for phase_name, phase in phases.items():
            for transition in phase.get("transitions", []):
                if transition.get("to") not in phases:
                    errors.append(f"Phase '{phase_name}' has transition to unknown phase '{transition.get('to')}'")

        # Check execute/evaluate phases have prompts
        for phase_name, phase in phases.items():
            phase_type = phase.get("type", "execute")
            if phase_type in ("execute", "evaluate"):
                if not phase.get("prompt"):
                    errors.append(f"Phase '{phase_name}' of type '{phase_type}' requires a prompt")

        # Check script phases have commands
        for phase_name, phase in phases.items():
            if phase.get("type") == "script":
                if not phase.get("command"):
                    errors.append(f"Script phase '{phase_name}' requires a command")

        # Check at least one terminal phase exists
        terminal_phases = [name for name, p in phases.items() if p.get("type") == "terminal"]
        if not terminal_phases:
            errors.append("Workflow has no terminal phase")

        return errors

    def duplicate_workflow(self, source_name: str, target_name: str) -> str:
        """Duplicate a workflow with a new name."""
        if not target_name or "/" in target_name or "\\" in target_name or ".." in target_name:
            raise ValueError("Invalid target workflow name")

        source_path = self._resolve_workflow_name(source_name)
        target_path = self._resolve_workflow_name(target_name)

        if not source_path.exists():
            raise FileNotFoundError(f"Source workflow not found: {source_name}")
        if target_path.exists():
            raise ValueError(f"Target workflow already exists: {target_name}")

        # Load source and update name
        data = self.get_workflow_full(source_name)
        data["workflow"]["name"] = target_name

        self.save_workflow(target_name, data)
        return target_name

    def delete_workflow(self, name: str) -> None:
        """Delete a workflow file."""
        path = self._resolve_workflow_name(name)

        if not path.exists():
            raise FileNotFoundError(f"Workflow not found: {name}")

        # Safety check: don't allow deleting default workflow
        if name == "default" or path.stem == "default":
            raise ValueError("Cannot delete the default workflow")

        with self._lock:
            path.unlink()

    def get_status_fields(self) -> List[str]:
        """Return list of known status field names for autocomplete."""
        return list(self.KNOWN_STATUS_FIELDS)


class JeevesPromptManager:
    """Read/write Jeeves prompt templates from prompts/ directory."""

    def __init__(self, prompt_dir: Path):
        self.prompt_dir = prompt_dir.resolve()
        self._lock = Lock()

    def list_prompts(self) -> List[Dict]:
        prompts: List[Dict] = []
        try:
            for path in sorted(self.prompt_dir.glob("*.md")):
                if not path.is_file():
                    continue
                stat = path.stat()
                prompts.append(
                    {
                        "id": path.name,
                        "name": path.name,
                        "mtime": stat.st_mtime,
                        "size": stat.st_size,
                    }
                )
        except Exception:
            return []
        return prompts

    def read_prompt(self, prompt_id: str) -> Dict:
        path = self._resolve_prompt_id(prompt_id)
        try:
            content = path.read_text(encoding="utf-8")
            stat = path.stat()
        except Exception as e:
            raise RuntimeError(f"Failed to read {path.name}: {e}")
        return {
            "id": path.name,
            "name": path.name,
            "content": content,
            "mtime": stat.st_mtime,
            "size": stat.st_size,
        }

    def write_prompt(self, prompt_id: str, content: str) -> Dict:
        if not isinstance(content, str):
            raise ValueError("content must be a string")
        if len(content.encode("utf-8", errors="replace")) > 512_000:
            raise ValueError("content too large (max 512KB)")

        path = self._resolve_prompt_id(prompt_id)
        tmp_path = path.with_suffix(path.suffix + ".tmp")

        with self._lock:
            try:
                tmp_path.write_text(content, encoding="utf-8")
                tmp_path.replace(path)
            finally:
                try:
                    tmp_path.unlink()
                except Exception:
                    pass

        return self.read_prompt(prompt_id)

    def _resolve_prompt_id(self, prompt_id: str) -> Path:
        if not isinstance(prompt_id, str) or not prompt_id:
            raise ValueError("prompt id is required")
        if "/" in prompt_id or "\\" in prompt_id:
            raise ValueError("invalid prompt id")
        if not prompt_id.endswith(".md"):
            raise ValueError("invalid prompt id")

        path = (self.prompt_dir / prompt_id).resolve()
        try:
            path.relative_to(self.prompt_dir)
        except Exception as e:
            raise ValueError("invalid prompt id") from e

        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f"prompt not found: {prompt_id}")
        return path



class LogWatcher:
    """Watch log file for changes and track position"""
    
    def __init__(self, path: Path):
        self.path = path
        self.position = 0
        self.last_mtime = 0
        self.last_size = 0
        self._lock = Lock()
    
    def get_new_lines(self) -> Tuple[List[str], bool]:
        """Get new lines since last read. Returns (lines, has_changes)"""
        with self._lock:
            if not self.path.exists():
                self.position = 0
                self.last_mtime = 0
                self.last_size = 0
                return [], False
            
            try:
                stat = self.path.stat()
                mtime = stat.st_mtime
                size = stat.st_size
                
                # File was truncated or replaced
                if size < self.last_size:
                    self.position = 0
                
                # No changes
                if mtime == self.last_mtime and size == self.last_size:
                    return [], False
                
                self.last_mtime = mtime
                self.last_size = size
                
                with open(self.path, 'r', errors='replace') as f:
                    f.seek(self.position)
                    content = f.read()
                    self.position = f.tell()
                
                if not content:
                    return [], False
                
                lines = content.splitlines()
                return lines, True
                
            except Exception:
                return [], False
    
    def get_all_lines(self, max_lines: int = 500) -> List[str]:
        """Get all lines (for initial load)"""
        with self._lock:
            if not self.path.exists():
                return []
            
            try:
                with open(self.path, 'r', errors='replace') as f:
                    lines = f.readlines()
                    self.position = f.tell()
                
                stat = self.path.stat()
                self.last_mtime = stat.st_mtime
                self.last_size = stat.st_size
                
                return [line.rstrip('\n') for line in lines[-max_lines:]]
            except Exception:
                return []
    
    def reset(self):
        """Reset position to start"""
        with self._lock:
            self.position = 0
            self.last_mtime = 0
            self.last_size = 0


class SDKOutputWatcher:
    """Watch SDK output file for changes and track message/tool call counts.

    Similar to LogWatcher but specialized for sdk-output.json files.
    Tracks message and tool call counts to return only new items since last check.
    """

    def __init__(self, path: Path):
        self.path = path
        self.last_mtime: float = 0
        self.last_size: int = 0
        self.last_message_count: int = 0
        self.last_tool_count: int = 0
        self._lock = Lock()

    def get_updates(self) -> Tuple[List[Dict], List[Dict], bool]:
        """Get new messages and tool calls since last check.

        Returns:
            Tuple of (new_messages, new_tool_calls, has_changes)
        """
        with self._lock:
            if not self.path.exists():
                self.last_mtime = 0
                self.last_size = 0
                self.last_message_count = 0
                self.last_tool_count = 0
                return [], [], False

            try:
                stat = self.path.stat()
                mtime = stat.st_mtime
                size = stat.st_size

                # No changes to file
                if mtime == self.last_mtime and size == self.last_size:
                    return [], [], False

                self.last_mtime = mtime
                self.last_size = size

                with open(self.path, 'r', errors='replace') as f:
                    data = json.load(f)

                messages = data.get("messages", [])
                tool_calls = data.get("tool_calls", [])

                # Get new items since last check
                new_messages = messages[self.last_message_count:]
                new_tool_calls = tool_calls[self.last_tool_count:]

                # Update counts
                prev_msg_count = self.last_message_count
                prev_tool_count = self.last_tool_count
                self.last_message_count = len(messages)
                self.last_tool_count = len(tool_calls)

                # Determine if there are actual changes
                has_changes = len(new_messages) > 0 or len(new_tool_calls) > 0

                return new_messages, new_tool_calls, has_changes

            except (json.JSONDecodeError, ValueError):
                # Malformed JSON - return empty but don't crash
                return [], [], False
            except Exception:
                return [], [], False

    def reset(self):
        """Reset tracking state to start fresh."""
        with self._lock:
            self.last_mtime = 0
            self.last_size = 0
            self.last_message_count = 0
            self.last_tool_count = 0


class JeevesState:
    """Track Jeeves's current state from files"""
    
    def __init__(self, state_dir: str):
        self.state_dir = Path(state_dir)
        self.prd_file = self.state_dir / "prd.json"
        self.issue_file = self.state_dir / "issue.json"
        self.progress_file = self.state_dir / "progress.txt"
        self.last_run_log = self.state_dir / "last-run.log"
        self.viewer_run_log = self.state_dir / "viewer-run.log"
        
        # State cache
        self.last_update = 0
        self._cache: Dict = {}
        self._cache_lock = Lock()
        
        # Track file modification times for change detection
        self._file_mtimes: Dict[str, float] = {}
    
    def _get_mtime(self, path: Path) -> float:
        """Get file modification time, 0 if doesn't exist"""
        try:
            return path.stat().st_mtime if path.exists() else 0
        except Exception:
            return 0
    
    def _files_changed(self) -> bool:
        """Check if any state files have changed"""
        files = [self.prd_file, self.issue_file, self.progress_file, self.last_run_log, self.viewer_run_log]
        
        for f in files:
            mtime = self._get_mtime(f)
            key = str(f)
            if self._file_mtimes.get(key, 0) != mtime:
                self._file_mtimes[key] = mtime
                return True
        return False
    
    def get_state(self, force: bool = False, include_recent_logs: bool = True) -> Dict:
        """Get current Jeeves state"""
        now = time.time()
        
        # Check cache (50ms cache to avoid hammering disk)
        with self._cache_lock:
            if not force and now - self.last_update < 0.05 and self._cache:
                cached = copy.deepcopy(self._cache)
                if include_recent_logs:
                    cached["recent_logs"] = self.get_recent_logs(500)
                else:
                    cached["recent_logs"] = []
                return cached
        
        state = {
            "timestamp": datetime.now().isoformat(),
            "mode": "unknown",
            "config": {},
            "status": {},
            "progress_lines": [],
            "recent_logs": [],
            "iteration": self._parse_iteration(),
            "started_at": self._get_started_time(),
        }
        
        # Determine mode
        if self.issue_file.exists():
            state["mode"] = "issue"
            state["config"] = self._read_json(self.issue_file) or {}
        elif self.prd_file.exists():
            state["mode"] = "prd"
            state["config"] = self._read_json(self.prd_file) or {}
        
        # Get progress
        if self.progress_file.exists():
            state["progress_lines"] = self._read_lines_tail(self.progress_file, 100)
        
        # Get recent logs (optional; avoid reading large files for SSE state updates)
        if include_recent_logs:
            state["recent_logs"] = self.get_recent_logs(500)
        
        # Parse status based on mode
        if state["mode"] == "issue":
            config = state["config"]
            issue = config.get("issue", {})
            phase = config.get("phase", "design_draft")
            state["status"] = {
                "phase": phase,
                "issue_number": issue.get("number") or config.get("issueNumber"),
                "issue_url": issue.get("url"),
                "issue_title": issue.get("title", ""),
                "branch_name": config.get("branch") or config.get("branchName"),
                "design_doc": config.get("designDocPath") or config.get("designDoc"),
            }
        elif state["mode"] == "prd":
            config = state["config"]
            stories = config.get("userStories", [])
            total = len(stories)
            passing = sum(1 for s in stories if s.get("passes", False))
            state["status"] = {
                "phase": "prd",
                "total_stories": total,
                "passing_stories": passing,
                "remaining_stories": total - passing,
                "stories": [
                    {"id": i+1, "title": s.get("title", s.get("description", f"Story {i+1}")[:50]), "passes": s.get("passes", False)}
                    for i, s in enumerate(stories)
                ]
            }
        
        # Update cache
        with self._cache_lock:
            cache_copy = copy.deepcopy(state)
            cache_copy["recent_logs"] = []
            self._cache = cache_copy
            self.last_update = now
        
        return state

    def _get_log_path(self) -> Path:
        if self.last_run_log.exists() and self.last_run_log.stat().st_size > 0:
            return self.last_run_log
        if self.viewer_run_log.exists() and self.viewer_run_log.stat().st_size > 0:
            return self.viewer_run_log
        return self.last_run_log

    def get_recent_logs(self, max_lines: int = 500) -> List[str]:
        """Read last N log lines without affecting SSE streaming cursor."""
        log_path = self._get_log_path()
        if not log_path.exists():
            return []
        return self._read_lines_tail(log_path, max_lines)
    
    def _parse_iteration(self) -> Optional[Dict]:
        """Parse current iteration from progress file"""
        if not self.progress_file.exists():
            return None
        
        try:
            content = self.progress_file.read_text()
            # Look for "Jeeves Iteration X of Y" pattern
            match = re.search(r'Iteration\s+(\d+)\s+of\s+(\d+)', content, re.IGNORECASE)
            if match:
                return {
                    "current": int(match.group(1)),
                    "max": int(match.group(2))
                }
        except Exception:
            pass
        return None
    
    def _get_started_time(self) -> Optional[str]:
        """Get run start time from progress file"""
        if not self.progress_file.exists():
            return None
        
        try:
            content = self.progress_file.read_text()
            match = re.search(r'Started:\s*(.+)$', content, re.MULTILINE)
            if match:
                return match.group(1).strip()
        except Exception:
            pass
        return None
    
    # Phase selection is stored directly in issue.json for SDK-only mode.
    
    def _read_json(self, path: Path) -> Optional[Dict]:
        """Read JSON file"""
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except Exception:
            return None
    
    def _read_lines_tail(self, path: Path, count: int) -> List[str]:
        """Read last N lines from file"""
        try:
            with open(path, 'r', errors='replace') as f:
                lines = f.readlines()
                return [line.rstrip('\n') for line in lines[-count:]]
        except Exception:
            return []


class JeevesRunManager:
    """Start/stop SDK runs from the viewer (single run at a time).

    Implements the Ralph Wiggum iteration pattern where each iteration runs
    in a fresh context window (separate subprocess). Handoff between iterations
    happens via files (progress.txt). The iteration loop lives here in the
    orchestrator, not inside the SDK runner.
    """

    # Completion promise that agents should output when done
    COMPLETION_PROMISE = "<promise>COMPLETE</promise>"

    def __init__(
        self,
        *,
        issue_ref: Optional[str] = None,
        state_dir: Optional[Path] = None,
        prompts_dir: Optional[Path] = None,
        python_exe: Optional[str] = None,
        runner_cmd_override: Optional[List[str]] = None,
    ):
        self.issue_ref = issue_ref
        self._owner: Optional[str] = None
        self._repo: Optional[str] = None
        self._issue_number: Optional[int] = None
        self.prompts_dir = prompts_dir or (Path(__file__).resolve().parent.parent.parent.parent / "prompts")
        self.python_exe = python_exe or sys.executable
        self.runner_cmd_override = runner_cmd_override

        if issue_ref:
            self._owner, self._repo, self._issue_number = parse_issue_ref(issue_ref)
            self.state_dir = get_issue_state_dir(self._owner, self._repo, self._issue_number)
            self.work_dir = get_worktree_path(self._owner, self._repo, self._issue_number)
        elif state_dir:
            self.state_dir = state_dir.resolve()
            self.work_dir = self.state_dir.parent
        else:
            self.state_dir = Path.cwd() / "jeeves"
            self.work_dir = Path.cwd()

        self._lock = Lock()
        self._proc: Optional[subprocess.Popen] = None
        self._iteration_thread: Optional[Thread] = None
        self._stop_requested: bool = False
        self._workflow_engine: Optional[WorkflowEngine] = None
        self._run_info: Dict = {
            "running": False,
            "pid": None,
            "started_at": None,
            "ended_at": None,
            "returncode": None,
            "command": None,
            "max_iterations": None,
            "inactivity_timeout_sec": None,
            "iteration_timeout_sec": None,
            "sdk_max_buffer_size": None,
            "current_iteration": 0,
            "completed_via_promise": False,
            "completed_via_state": False,
            "completion_reason": None,
            "viewer_log_file": str(self.state_dir / "viewer-run.log"),
            "last_error": None,
            "issue_ref": issue_ref,
        }

    def set_issue(self, issue_ref: str) -> None:
        self._owner, self._repo, self._issue_number = parse_issue_ref(issue_ref)
        self.issue_ref = issue_ref
        self.state_dir = get_issue_state_dir(self._owner, self._repo, self._issue_number)
        self.work_dir = get_worktree_path(self._owner, self._repo, self._issue_number)
        self._run_info["viewer_log_file"] = str(self.state_dir / "viewer-run.log")
        self._run_info["issue_ref"] = issue_ref

    def _get_workflow_engine(self, workflow_name: str = "default") -> WorkflowEngine:
        """Get or create workflow engine for the given workflow."""
        if self._workflow_engine is None or self._workflow_engine.workflow.name != workflow_name:
            try:
                workflow = load_workflow_by_name(workflow_name)
                self._workflow_engine = WorkflowEngine(workflow)
            except Exception as e:
                # Fall back to default workflow if specified one fails
                if workflow_name != "default":
                    # Can't easily log here without viewer_log_path, so just try default
                    workflow = load_workflow_by_name("default")
                    self._workflow_engine = WorkflowEngine(workflow)
                else:
                    raise RuntimeError(f"Failed to load default workflow: {e}") from e
        return self._workflow_engine

    def get_status(self) -> Dict:
        with self._lock:
            proc = self._proc
            iteration_thread = self._iteration_thread

            # Check if iteration loop is running
            iteration_running = iteration_thread is not None and iteration_thread.is_alive()

            if proc is not None and proc.poll() is None:
                self._run_info["running"] = True
                self._run_info["pid"] = proc.pid
            elif iteration_running:
                # Iteration loop is running but between iterations
                self._run_info["running"] = True
                self._run_info["pid"] = None
            else:
                if proc is not None and self._run_info.get("returncode") is None:
                    self._run_info["returncode"] = proc.poll()
                self._run_info["running"] = False
                self._run_info["pid"] = None
            return copy.deepcopy(self._run_info)

    def get_viewer_logs_tail(self, max_lines: int = 200) -> List[str]:
        log_path = Path(self._run_info.get("viewer_log_file", ""))
        if not log_path.exists():
            return []
        try:
            with open(log_path, "r", errors="replace") as f:
                lines = f.readlines()
            return [line.rstrip("\n") for line in lines[-max_lines:]]
        except Exception:
            return []

    def start(
        self,
        *,
        max_iterations: int = 10,
        inactivity_timeout_sec: float = 600.0,
        iteration_timeout_sec: float = 3600.0,
        sdk_max_buffer_size: Optional[int] = None,
    ) -> Dict:
        """Start the iteration loop - spawns fresh SDK runner each iteration.

        Args:
            max_iterations: Maximum number of fresh-context iterations
            inactivity_timeout_sec: Maximum idle time (seconds) without progress
                in state files (last-run.log / sdk-output.json) before aborting.
            iteration_timeout_sec: Maximum wall-clock time (seconds) for a single
                iteration before aborting.

        The iteration loop runs in a background thread. Each iteration:
        1. Spawns a fresh SDK runner subprocess (new context window)
        2. Waits for it to complete
        3. Checks output for <promise>COMPLETE</promise>
        4. If found, stops. If not, starts next iteration.

        Handoff between iterations happens via progress.txt - the agent
        reads it at the start of each iteration to understand prior work.
        """
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                raise RuntimeError("Jeeves is already running")
            if self._iteration_thread is not None and self._iteration_thread.is_alive():
                raise RuntimeError("Jeeves iteration loop is already running")

            if not self.issue_ref:
                raise ValueError("No issue selected. Use /api/issues/select first.")

            # Verify worktree exists
            if not self.work_dir.exists():
                raise FileNotFoundError(
                    f"Worktree not found at {self.work_dir}. "
                    f"Run: jeeves init --repo {self._owner}/{self._repo} --issue {self._issue_number}"
                )

            viewer_log_path = Path(self._run_info["viewer_log_file"])
            viewer_log_path.parent.mkdir(parents=True, exist_ok=True)
            viewer_log_path.write_text("")

            started_at = datetime.now().isoformat()

            self._stop_requested = False
            self._run_info = {
                "running": True,
                "pid": None,
                "started_at": started_at,
                "ended_at": None,
                "returncode": None,
                "command": None,
                "max_iterations": max_iterations,
                "inactivity_timeout_sec": inactivity_timeout_sec,
                "iteration_timeout_sec": iteration_timeout_sec,
                "sdk_max_buffer_size": sdk_max_buffer_size,
                "current_iteration": 0,
                "completed_via_promise": False,
                "completed_via_state": False,
                "completion_reason": None,
                "viewer_log_file": str(viewer_log_path),
                "last_error": None,
                "issue_ref": self.issue_ref,
            }

            # Start iteration loop in background thread
            self._iteration_thread = Thread(
                target=self._run_iteration_loop,
                args=(
                    max_iterations,
                    viewer_log_path,
                    inactivity_timeout_sec,
                    iteration_timeout_sec,
                    sdk_max_buffer_size,
                ),
                daemon=True,
            )
            self._iteration_thread.start()

            return copy.deepcopy(self._run_info)

    def _run_iteration_loop(
        self,
        max_iterations: int,
        viewer_log_path: Path,
        inactivity_timeout_sec: float,
        iteration_timeout_sec: float,
        sdk_max_buffer_size: Optional[int],
    ) -> None:
        """Run the iteration loop (called in background thread).

        This is the Ralph Wiggum pattern: each iteration is a fresh subprocess
        with a new context window. Handoff happens via files (progress.txt).
        """
        try:
            for iteration in range(1, max_iterations + 1):
                if self._stop_requested:
                    self._log_to_file(viewer_log_path, f"[ITERATION] Stop requested, ending at iteration {iteration}")
                    break

                with self._lock:
                    self._run_info["current_iteration"] = iteration

                self._log_to_file(viewer_log_path, f"")
                self._log_to_file(viewer_log_path, f"{'='*60}")
                self._log_to_file(viewer_log_path, f"[ITERATION {iteration}/{max_iterations}] Starting fresh context")
                self._log_to_file(viewer_log_path, f"{'='*60}")

                # Run a single iteration
                result = self._run_single_iteration(
                    viewer_log_path,
                    iteration_timeout=iteration_timeout_sec,
                    inactivity_timeout=inactivity_timeout_sec,
                    sdk_max_buffer_size=sdk_max_buffer_size,
                )

                # Check for completion via workflow engine transitions
                issue_json = self._read_issue_json()
                if issue_json:
                    workflow_name = issue_json.get("workflow", "default")
                    engine = self._get_workflow_engine(workflow_name)
                    current_phase = issue_json.get("phase", "design_draft")

                    next_phase = engine.evaluate_transitions(current_phase, issue_json)
                    if next_phase:
                        # Update phase in issue.json
                        issue_json["phase"] = next_phase
                        self._write_issue_json(issue_json)

                        if engine.is_terminal(next_phase):
                            self._log_to_file(viewer_log_path, f"")
                            self._log_to_file(viewer_log_path, f"[COMPLETE] Reached terminal phase: {next_phase}")
                            with self._lock:
                                self._run_info["completed_via_state"] = True
                                self._run_info["completion_reason"] = f"reached terminal phase: {next_phase}"
                            break

                        # Continue to next phase
                        self._log_to_file(viewer_log_path, f"[TRANSITION] {current_phase} -> {next_phase}")

                # Check for completion promise in SDK output
                if self._check_completion_promise():
                    self._log_to_file(viewer_log_path, f"")
                    self._log_to_file(viewer_log_path, f"[COMPLETE] Agent signaled completion after {iteration} iteration(s)")
                    with self._lock:
                        self._run_info["completed_via_promise"] = True
                        self._run_info["completion_reason"] = "completion promise found in output"
                    break

                # Check if iteration failed
                if result != 0:
                    self._log_to_file(viewer_log_path, f"[ITERATION] Iteration {iteration} exited with code {result}")

                # Small delay between iterations to allow file writes to settle
                time.sleep(0.5)

            else:
                # Loop completed without completion promise
                self._log_to_file(viewer_log_path, f"")
                self._log_to_file(viewer_log_path, f"[MAX ITERATIONS] Reached {max_iterations} iterations without completion")

        except Exception as e:
            self._log_to_file(viewer_log_path, f"[ERROR] Iteration loop error: {e}")
            with self._lock:
                self._run_info["last_error"] = str(e)

        finally:
            ended_at = datetime.now().isoformat()
            with self._lock:
                self._run_info["running"] = False
                self._run_info["ended_at"] = ended_at
                self._proc = None

    def _ensure_jeeves_symlink(self, viewer_log_path: Path) -> bool:
        """Ensure the .jeeves symlink exists in the worktree.

        The agent needs to read .jeeves/issue.json from the worktree.
        This is normally a symlink created by create_worktree, but it can
        fail silently on some systems. This method checks and repairs it.

        Returns:
            True if .jeeves/issue.json is accessible, False otherwise.
        """
        jeeves_path = self.work_dir / ".jeeves"
        issue_json_via_symlink = jeeves_path / "issue.json"

        # Check if already accessible
        if issue_json_via_symlink.exists():
            return True

        # Check if the state directory has the file
        state_issue_json = self.state_dir / "issue.json"
        if not state_issue_json.exists():
            self._log_to_file(
                viewer_log_path,
                f"[ERROR] issue.json not found in state directory: {self.state_dir}"
            )
            return False

        # Try to create/repair the symlink
        self._log_to_file(
            viewer_log_path,
            f"[SETUP] Creating .jeeves symlink: {jeeves_path} -> {self.state_dir}"
        )

        try:
            _create_state_symlink(
                self.work_dir,
                self._owner,
                self._repo,
                self._issue_number,
            )
        except Exception as e:
            self._log_to_file(
                viewer_log_path,
                f"[WARNING] Could not create .jeeves symlink: {e}"
            )

        # Check again after attempting to create
        if issue_json_via_symlink.exists():
            self._log_to_file(viewer_log_path, "[SETUP] .jeeves symlink created successfully")
            return True

        # If symlink still doesn't work, provide helpful error
        self._log_to_file(
            viewer_log_path,
            f"[ERROR] Cannot access .jeeves/issue.json from worktree"
        )
        self._log_to_file(
            viewer_log_path,
            f"[ERROR] Worktree: {self.work_dir}"
        )
        self._log_to_file(
            viewer_log_path,
            f"[ERROR] State dir: {self.state_dir}"
        )
        self._log_to_file(
            viewer_log_path,
            "[ERROR] The agent needs .jeeves/ to be a symlink to the state directory."
        )
        self._log_to_file(
            viewer_log_path,
            f"[ERROR] Try manually: ln -s {self.state_dir} {jeeves_path}"
        )
        return False

    def _run_single_iteration(
        self,
        viewer_log_path: Path,
        *,
        iteration_timeout: float = 3600.0,
        inactivity_timeout: float = 600.0,
        sdk_max_buffer_size: Optional[int] = None,
    ) -> int:
        """Run a single SDK iteration (fresh subprocess, fresh context).

        Uses streaming I/O to prevent deadlocks when subprocess produces
        large output without newlines (e.g., large file reads).

        Args:
            viewer_log_path: Path to the log file for this iteration.
            iteration_timeout: Maximum time in seconds for this iteration.
            inactivity_timeout: Maximum time in seconds without updates to
                last-run.log or sdk-output.json before aborting the iteration.

        Returns the subprocess exit code.
        """
        # Ensure .jeeves symlink exists before running
        if not self._ensure_jeeves_symlink(viewer_log_path):
            return 1

        issue_state = IssueState.load(self._owner, self._repo, self._issue_number)

        # Get workflow engine
        issue_json = self._read_issue_json() or {}
        workflow_name = issue_json.get("workflow", "default")
        engine = self._get_workflow_engine(workflow_name)
        current_phase = issue_state.phase

        phase_type = engine.get_phase_type(current_phase)

        # Check for invalid phase
        if phase_type is None:
            error_msg = f"[ERROR] Invalid phase '{current_phase}' not found in workflow '{workflow_name}'"
            self._log_to_file(viewer_log_path, error_msg)
            return 1

        # Handle script phases without spawning AI
        if phase_type == PhaseType.SCRIPT:
            phase = engine.get_phase(current_phase)
            self._log_to_file(viewer_log_path, f"[SCRIPT] Running script phase: {current_phase}")
            result = run_script_phase(phase, self.work_dir, issue_json)

            # Update status from script result
            if result.status_updates:
                status = issue_json.get("status", {})
                status.update(result.status_updates)
                issue_json["status"] = status
                self._write_issue_json(issue_json)

            self._log_to_file(viewer_log_path, f"[SCRIPT] Exit code: {result.exit_code}")
            return result.exit_code

        # Normal AI phase - resolve prompt using workflow engine
        prompt_path = resolve_prompt_path(current_phase, self.prompts_dir, engine)

        env = os.environ.copy()
        cmd: List[str]
        if self.runner_cmd_override:
            cmd = list(self.runner_cmd_override)
        else:
            cmd = [self.python_exe, "-m", "jeeves.runner.sdk_runner"]
        cmd += [
            "--prompt",
            str(prompt_path),
            "--output",
            str(self.state_dir / "sdk-output.json"),
            "--text-output",
            str(self.state_dir / "last-run.log"),
            "--work-dir",
            str(self.work_dir),
            "--state-dir",
            str(self.state_dir),
        ]
        if sdk_max_buffer_size is not None:
            cmd += ["--max-buffer-size", str(int(sdk_max_buffer_size))]

        with self._lock:
            self._run_info["command"] = cmd

        # Use subprocess.PIPE with a reader thread to prevent I/O deadlocks
        # This avoids buffering issues when subprocess produces large output
        # without newlines (e.g., reading large files)
        proc = subprocess.Popen(
            cmd,
            cwd=str(self.work_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # Combine streams to avoid separate deadlocks
            start_new_session=True,
            text=True,
        )

        with self._lock:
            self._proc = proc
            self._run_info["pid"] = proc.pid

        # Stream output to file via reader thread
        output_queue: Queue = Queue()

        def reader_thread():
            """Read from subprocess stdout and put lines in queue."""
            try:
                assert proc.stdout is not None
                while True:
                    line = proc.stdout.readline()
                    if not line:
                        break
                    output_queue.put(line)
            except Exception as e:
                output_queue.put(f"[READER ERROR] {e}\n")
            finally:
                output_queue.put(None)  # Sentinel to signal completion

        reader = Thread(target=reader_thread, daemon=True)
        reader.start()

        deadline = time.time() + float(iteration_timeout)
        returncode: Optional[int] = None

        try:
            last_run_log_path = self.state_dir / "last-run.log"
            sdk_output_path = self.state_dir / "sdk-output.json"

            def _safe_mtime(path: Path) -> Optional[float]:
                try:
                    return path.stat().st_mtime
                except Exception:
                    return None

            last_activity_at = time.time()
            last_last_run_mtime = _safe_mtime(last_run_log_path)
            last_sdk_output_mtime = _safe_mtime(sdk_output_path)

            with open(viewer_log_path, "a", encoding="utf-8") as log_file:
                while True:
                    remaining_time = deadline - time.time()
                    if remaining_time <= 0:
                        raise subprocess.TimeoutExpired(cmd, iteration_timeout)

                    # Detect progress via state file updates.
                    now = time.time()
                    updated = False
                    current_last_run_mtime = _safe_mtime(last_run_log_path)
                    if current_last_run_mtime is not None and (
                        last_last_run_mtime is None
                        or current_last_run_mtime > last_last_run_mtime
                    ):
                        last_last_run_mtime = current_last_run_mtime
                        updated = True

                    current_sdk_output_mtime = _safe_mtime(sdk_output_path)
                    if current_sdk_output_mtime is not None and (
                        last_sdk_output_mtime is None
                        or current_sdk_output_mtime > last_sdk_output_mtime
                    ):
                        last_sdk_output_mtime = current_sdk_output_mtime
                        updated = True

                    if updated:
                        last_activity_at = now

                    if inactivity_timeout > 0 and (now - last_activity_at) > inactivity_timeout:
                        self._log_to_file(
                            viewer_log_path,
                            f"[ERROR] Iteration inactive for {now - last_activity_at:.1f}s "
                            f"(no last-run.log/sdk-output.json updates); terminating process group",
                        )
                        try:
                            os.killpg(proc.pid, signal.SIGTERM)
                        except Exception:
                            try:
                                proc.terminate()
                            except Exception:
                                pass
                        try:
                            returncode = proc.wait(timeout=10.0)
                        except subprocess.TimeoutExpired:
                            try:
                                os.killpg(proc.pid, signal.SIGKILL)
                            except Exception:
                                try:
                                    proc.kill()
                                except Exception:
                                    pass
                            returncode = proc.wait()
                        break

                    try:
                        poll_interval = max(0.1, min(1.0, float(inactivity_timeout) / 4.0))
                        # Wait for output with timeout, checking frequently
                        item = output_queue.get(timeout=min(poll_interval, remaining_time))
                        if item is None:
                            # Reader thread finished
                            break
                        log_file.write(item)
                        log_file.flush()
                    except Empty:
                        # No output yet, check if process has exited
                        if proc.poll() is not None:
                            # Process exited, drain remaining output
                            while True:
                                try:
                                    item = output_queue.get_nowait()
                                    if item is None:
                                        break
                                    log_file.write(item)
                                except Empty:
                                    break
                            log_file.flush()
                            break

            # Process should have exited by now
            if returncode is None:
                returncode = proc.wait(timeout=5.0)

        except subprocess.TimeoutExpired:
            self._log_to_file(
                viewer_log_path,
                f"[ERROR] Iteration timed out after {iteration_timeout}s"
            )
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except Exception:
                proc.terminate()
            try:
                returncode = proc.wait(timeout=10.0)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    proc.kill()
                returncode = proc.wait()
        finally:
            reader.join(timeout=2.0)
            with self._lock:
                self._run_info["returncode"] = returncode
                self._run_info["pid"] = None

        return returncode if returncode is not None else -1

    def _read_issue_json(self) -> Optional[Dict]:
        """Read the raw issue.json for completion checks."""
        issue_path = self.state_dir / "issue.json"
        if not issue_path.exists():
            return None
        try:
            with open(issue_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _write_issue_json(self, data: Dict) -> None:
        """Write the issue.json file."""
        issue_path = self.state_dir / "issue.json"
        tmp_path = issue_path.with_suffix(".json.tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
                f.write("\n")
            tmp_path.replace(issue_path)
        except Exception as e:
            tmp_path.unlink(missing_ok=True)
            raise RuntimeError(f"Failed to write issue.json: {e}") from e

    def _check_completion_promise(self) -> bool:
        """Check if the agent output contains the completion promise."""
        sdk_output_path = self.state_dir / "sdk-output.json"
        if not sdk_output_path.exists():
            return False

        try:
            with open(sdk_output_path, "r") as f:
                data = json.load(f)

            # Check messages for the completion promise
            messages = data.get("messages", [])
            for msg in messages:
                content = msg.get("content", "")
                if content and self.COMPLETION_PROMISE in content:
                    return True

            # Also check the text output file
            text_output_path = self.state_dir / "last-run.log"
            if text_output_path.exists():
                text_content = text_output_path.read_text()
                if self.COMPLETION_PROMISE in text_content:
                    return True

        except (json.JSONDecodeError, IOError):
            pass

        return False

    def _log_to_file(self, path: Path, message: str) -> None:
        """Append a log message to a file."""
        try:
            with open(path, "a") as f:
                f.write(message + "\n")
                f.flush()
        except IOError:
            pass

    def stop(self, *, force: bool = False, timeout_sec: float = 5.0) -> Dict:
        """Stop the current run, including the iteration loop."""
        # Signal the iteration loop to stop
        self._stop_requested = True

        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                # No active process, but iteration loop might still be running
                pass
            else:
                # Kill the current subprocess
                try:
                    os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)
                except Exception:
                    try:
                        if force:
                            proc.kill()
                        else:
                            proc.terminate()
                    except Exception:
                        pass

                try:
                    proc.wait(timeout=timeout_sec)
                except Exception:
                    if not force:
                        return self.stop(force=True, timeout_sec=timeout_sec)

        # Wait for iteration thread to finish
        if self._iteration_thread is not None and self._iteration_thread.is_alive():
            self._iteration_thread.join(timeout=timeout_sec)

        return self.get_status()


class JeevesViewerHandler(SimpleHTTPRequestHandler):
    """HTTP handler for Jeeves viewer"""

    protocol_version = "HTTP/1.1"

    def __init__(
        self,
        *args,
        state: JeevesState,
        run_manager: JeevesRunManager,
        prompt_manager: JeevesPromptManager,
        workflow_manager: JeevesWorkflowManager,
        allow_remote_run: bool = False,
        **kwargs,
    ):
        self.state = state
        self.run_manager = run_manager
        self.prompt_manager = prompt_manager
        self.workflow_manager = workflow_manager
        self.allow_remote_run = allow_remote_run
        super().__init__(*args, **kwargs)

    def handle(self):
        """Handle request with graceful connection error handling."""
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            # Client disconnected before/during request - this is normal
            pass

    def do_GET(self):
        """Handle GET requests"""
        parsed = urlparse(self.path)
        path = parsed.path

        # Redirect root to index.html in static directory
        if path == "/":
            self.path = "/static/index.html"

        if path == "/api/state":
            data = self.state.get_state()
            data["run"] = self.run_manager.get_status()
            self._send_json(data)
        elif path == "/api/prompts":
            self._handle_prompts_list()
        elif path.startswith("/api/prompts/"):
            self._handle_prompt_get(path[len("/api/prompts/"):])
        elif path == "/api/stream":
            self._handle_sse()
        elif path == "/api/logs":
            self._send_json({"logs": self.state.get_recent_logs(1000)})
        elif path == "/api/run":
            self._send_json({"run": self.run_manager.get_status()})
        elif path == "/api/run/logs":
            self._send_json({"logs": self.run_manager.get_viewer_logs_tail(500)})
        elif path == "/api/init/issue/script":
            self._handle_init_issue_script_info()
        elif path == "/api/sdk-output":
            self._handle_sdk_output()
        elif path == "/api/sdk-output/messages":
            self._handle_sdk_output_messages()
        elif path == "/api/sdk-output/tool-calls":
            self._handle_sdk_output_tool_calls()
        elif path == "/api/issues":
            self._handle_list_issues()
        elif path == "/api/data-dir":
            self._handle_data_dir_info()
        elif path == "/api/workflow":
            self._handle_workflow()
        elif path == "/api/workflows":
            self._handle_workflows_list()
        elif path.startswith("/api/workflow/") and path.endswith("/full"):
            # Extract workflow name: /api/workflow/{name}/full
            parts = path.split("/")
            if len(parts) >= 4:
                workflow_name = parts[3]
                self._handle_workflow_get_full(workflow_name)
            else:
                self.send_error(404, "Not Found")
        elif path == "/api/status-fields":
            self._handle_status_fields()
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/run":
            self._handle_run_start()
            return
        if path == "/api/run/stop":
            self._handle_run_stop()
            return
        if path == "/api/issue/status":
            self._handle_issue_status_update()
            return
        if path.startswith("/api/prompts/"):
            self._handle_prompt_save(path[len("/api/prompts/"):])
            return
        if path == "/api/init/issue":
            self._handle_init_issue()
            return
        if path == "/api/issues/select":
            self._handle_select_issue()
            return
        # Workflow API routes: /api/workflow/{name}, /api/workflow/{name}/validate, /api/workflow/{name}/duplicate
        if path.startswith("/api/workflow/"):
            parts = path.split("/")
            if len(parts) >= 4:
                workflow_name = parts[3]
                if len(parts) == 4:
                    # POST /api/workflow/{name} - save workflow
                    self._handle_workflow_save(workflow_name)
                    return
                elif len(parts) == 5 and parts[4] == "validate":
                    # POST /api/workflow/{name}/validate
                    self._handle_workflow_validate(workflow_name)
                    return
                elif len(parts) == 5 and parts[4] == "duplicate":
                    # POST /api/workflow/{name}/duplicate
                    self._handle_workflow_duplicate(workflow_name)
                    return

        self.send_error(404, "Not Found")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_DELETE(self):
        """Handle DELETE requests"""
        parsed = urlparse(self.path)
        path = parsed.path

        # DELETE /api/workflow/{name}
        if path.startswith("/api/workflow/"):
            parts = path.split("/")
            if len(parts) == 4:
                workflow_name = parts[3]
                self._handle_workflow_delete(workflow_name)
                return

        self.send_error(404, "Not Found")

    def _is_local_request(self) -> bool:
        ip = (self.client_address[0] or "").strip()
        return ip == "127.0.0.1" or ip == "::1"

    def _read_json_body(self) -> Dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0

        if length <= 0:
            return {}

        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _handle_run_start(self):
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json(
                {
                    "ok": False,
                    "error": "Run control is only allowed from localhost. Restart the viewer with --allow-remote-run to enable it.",
                },
                status=403,
            )
            return

        body = self._read_json_body()

        # If issue_ref is provided, select that issue first
        issue_ref = body.get("issue_ref")
        if issue_ref:
            try:
                self.run_manager.set_issue(issue_ref)
                save_active_issue(issue_ref)  # Persist for server restarts
                # Update the state tracker to point to the new state dir
                self.state.state_dir = self.run_manager.state_dir
                self.state.prd_file = self.state.state_dir / "prd.json"
                self.state.issue_file = self.state.state_dir / "issue.json"
                self.state.progress_file = self.state.state_dir / "progress.txt"
                self.state.last_run_log = self.state.state_dir / "last-run.log"
                self.state.viewer_run_log = self.state.state_dir / "viewer-run.log"
            except ValueError as e:
                self._send_json({"ok": False, "error": str(e), "run": self.run_manager.get_status()}, status=400)
                return
            except Exception as e:
                self._send_json({"ok": False, "error": f"Failed to select issue: {e}", "run": self.run_manager.get_status()}, status=500)
                return

        for unsupported in ("runner", "mode", "output_mode", "print_prompt", "prompt_append", "env"):
            if unsupported in body:
                self._send_json({"ok": False, "error": f"Unsupported field: {unsupported}"}, status=400)
                return

        # max_iterations controls total fresh-context iterations (Ralph Wiggum pattern)
        max_iterations = body.get("max_iterations", 10)
        try:
            max_iterations = int(max_iterations)
        except Exception as e:
            self._send_json({"ok": False, "error": f"max_iterations must be an integer: {e}"}, status=400)
            return
        if max_iterations < 1:
            self._send_json({"ok": False, "error": "max_iterations must be >= 1"}, status=400)
            return

        inactivity_timeout_sec = body.get("inactivity_timeout_sec", 600.0)
        try:
            inactivity_timeout_sec = float(inactivity_timeout_sec)
        except Exception as e:
            self._send_json(
                {"ok": False, "error": f"inactivity_timeout_sec must be a number: {e}"},
                status=400,
            )
            return
        if inactivity_timeout_sec <= 0:
            self._send_json({"ok": False, "error": "inactivity_timeout_sec must be > 0"}, status=400)
            return

        iteration_timeout_sec = body.get("iteration_timeout_sec", 3600.0)
        try:
            iteration_timeout_sec = float(iteration_timeout_sec)
        except Exception as e:
            self._send_json(
                {"ok": False, "error": f"iteration_timeout_sec must be a number: {e}"},
                status=400,
            )
            return
        if iteration_timeout_sec <= 0:
            self._send_json({"ok": False, "error": "iteration_timeout_sec must be > 0"}, status=400)
            return

        sdk_max_buffer_size = body.get("max_buffer_size", None)
        if sdk_max_buffer_size is not None:
            try:
                sdk_max_buffer_size = int(sdk_max_buffer_size)
            except Exception as e:
                self._send_json(
                    {"ok": False, "error": f"max_buffer_size must be an integer: {e}"},
                    status=400,
                )
                return
            if sdk_max_buffer_size <= 0:
                self._send_json({"ok": False, "error": "max_buffer_size must be > 0"}, status=400)
                return

        try:
            run_info = self.run_manager.start(
                max_iterations=max_iterations,
                inactivity_timeout_sec=inactivity_timeout_sec,
                iteration_timeout_sec=iteration_timeout_sec,
                sdk_max_buffer_size=sdk_max_buffer_size,
            )
        except RuntimeError as e:
            self._send_json({"ok": False, "error": str(e), "run": self.run_manager.get_status()}, status=409)
            return
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e), "run": self.run_manager.get_status()}, status=400)
            return
        except FileNotFoundError as e:
            self._send_json({"ok": False, "error": str(e), "run": self.run_manager.get_status()}, status=404)
            return
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to start: {e}", "run": self.run_manager.get_status()}, status=500)
            return

        self._send_json({"ok": True, "run": run_info}, status=200)

    def _handle_run_stop(self):
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json(
                {
                    "ok": False,
                    "error": "Run control is only allowed from localhost. Restart the viewer with --allow-remote-run to enable it.",
                },
                status=403,
            )
            return

        body = self._read_json_body()
        force = bool(body.get("force", False))

        try:
            run_info = self.run_manager.stop(force=force)
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to stop: {e}", "run": self.run_manager.get_status()}, status=500)
            return

        self._send_json({"ok": True, "run": run_info})

    def _handle_prompts_list(self):
        self._send_json({"ok": True, "prompts": self.prompt_manager.list_prompts()})

    def _handle_prompt_get(self, prompt_id: str):
        try:
            prompt = self.prompt_manager.read_prompt(prompt_id)
        except FileNotFoundError as e:
            self._send_json({"ok": False, "error": str(e)}, status=404)
            return
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
            return
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to read: {e}"}, status=500)
            return
        self._send_json({"ok": True, "prompt": prompt})

    def _handle_prompt_save(self, prompt_id: str):
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json(
                {
                    "ok": False,
                    "error": "Editing prompts is only allowed from localhost. Restart the viewer with --allow-remote-run to enable it.",
                },
                status=403,
            )
            return

        body = self._read_json_body()
        content = body.get("content", None)

        try:
            prompt = self.prompt_manager.write_prompt(prompt_id, content)
        except FileNotFoundError as e:
            self._send_json({"ok": False, "error": str(e)}, status=404)
            return
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
            return
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to save: {e}"}, status=500)
            return

        self._send_json({"ok": True, "prompt": prompt})

    def _handle_issue_status_update(self):
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json(
                {
                    "ok": False,
                    "error": "Status overrides are only allowed from localhost. Restart the viewer with --allow-remote-run to enable it.",
                },
                status=403,
            )
            return

        if self.run_manager.get_status().get("running"):
            self._send_json({"ok": False, "error": "Cannot edit status while Jeeves is running."}, status=409)
            return

        issue_file = self.state.issue_file
        if not issue_file.exists():
            self._send_json({"ok": False, "error": "issue.json not found (issue mode not initialized)."}, status=404)
            return

        body = self._read_json_body()
        phase = (body.get("phase") or "").strip()

        try:
            raw = issue_file.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to read issue.json: {e}"}, status=500)
            return

        # Load workflow to validate phase
        workflow_name = data.get("workflow", "default")
        try:
            workflow = load_workflow_by_name(workflow_name)
            valid_phases = set(workflow.phases.keys())
        except FileNotFoundError:
            # Fallback to default phases if workflow not found
            valid_phases = {"design_draft", "design_review", "design_edit", "implement", "code_review", "code_fix", "complete"}

        if phase not in valid_phases:
            self._send_json({"ok": False, "error": f"phase must be one of: {', '.join(sorted(valid_phases))}"}, status=400)
            return

        data["phase"] = phase

        tmp_path = issue_file.with_suffix(issue_file.suffix + ".tmp")
        try:
            tmp_path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")
            tmp_path.replace(issue_file)
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to write issue.json: {e}"}, status=500)
            return
        finally:
            try:
                tmp_path.unlink()
            except Exception:
                pass

        self._send_json({"ok": True, "phase": phase})

    def _handle_init_issue_script_info(self):
        """Return info about init capability (for backward compatibility)."""
        self._send_json({
            "ok": True,
            "script": {
                "path": "viewer",
                "exists": True,
                "method": "viewer"
            }
        })

    def _handle_init_issue(self):
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json(
                {
                    "ok": False,
                    "error": "Init is only allowed from localhost. Restart the viewer with --allow-remote-run to enable it.",
                },
                status=403,
            )
            return

        if self.run_manager.get_status().get("running"):
            self._send_json({"ok": False, "error": "Cannot init while Jeeves is running."}, status=409)
            return

        body = self._read_json_body()

        issue_str = (body.get("issue") or "").strip()
        design_doc = (body.get("design_doc") or "").strip() or None
        repo_str = (body.get("repo") or "").strip()
        branch = (body.get("branch") or "").strip() or None
        force = bool(body.get("force", False))

        if not issue_str:
            self._send_json({"ok": False, "error": "issue is required"}, status=400)
            return

        if not repo_str:
            self._send_json({"ok": False, "error": "repo is required"}, status=400)
            return

        # Parse issue number
        try:
            issue_number = int(issue_str)
        except ValueError:
            self._send_json({"ok": False, "error": f"Invalid issue number: {issue_str}"}, status=400)
            return

        # Parse repo spec
        try:
            owner, repo_name = parse_repo_spec(repo_str)
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
            return

        output_lines = []

        try:
            # Step 1: Clone/fetch repository
            output_lines.append(f"Ensuring repository {owner}/{repo_name} is cloned...")
            repo_path = ensure_repo(owner, repo_name, fetch=True)
            output_lines.append(f"  Repository: {repo_path}")

            # Step 2: Create issue state
            output_lines.append("Creating issue state...")
            state = create_issue_state(
                owner=owner,
                repo=repo_name,
                issue_number=issue_number,
                branch=branch,
                design_doc=design_doc,
                fetch_metadata=True,
                force=force,
            )
            output_lines.append(f"  State: {state.state_dir}")
            if state.issue.title:
                output_lines.append(f"  Title: {state.issue.title}")

            # Step 3: Create worktree
            output_lines.append("Creating git worktree...")
            worktree_path = create_worktree(
                owner=owner,
                repo=repo_name,
                issue_number=issue_number,
                branch=state.branch,
            )
            output_lines.append(f"  Worktree: {worktree_path}")
            output_lines.append(f"  Branch: {state.branch}")

            # Set this as the active issue
            issue_ref = f"{owner}/{repo_name}#{issue_number}"
            self.run_manager.set_issue(issue_ref)
            save_active_issue(issue_ref)  # Persist for server restarts

            # Update the state tracker
            self.state.state_dir = self.run_manager.state_dir
            self.state.prd_file = self.state.state_dir / "prd.json"
            self.state.issue_file = self.state.state_dir / "issue.json"
            self.state.progress_file = self.state.state_dir / "progress.txt"
            self.state.last_run_log = self.state.state_dir / "last-run.log"
            self.state.viewer_run_log = self.state.state_dir / "viewer-run.log"

            output_lines.append("")
            output_lines.append("Ready! Use the viewer to start the run.")

            self._send_json({
                "ok": True,
                "issue_ref": issue_ref,
                "state_dir": str(state.state_dir),
                "worktree": str(worktree_path),
                "branch": state.branch,
                "issue_title": state.issue.title,
                "output": "\n".join(output_lines),
            })

        except IssueError as e:
            output_lines.append(f"Error: {e}")
            self._send_json({
                "ok": False,
                "error": str(e),
                "output": "\n".join(output_lines),
            }, status=400)

        except RepoError as e:
            output_lines.append(f"Error: {e}")
            self._send_json({
                "ok": False,
                "error": f"Repository error: {e}",
                "output": "\n".join(output_lines),
            }, status=400)

        except WorktreeError as e:
            output_lines.append(f"Error: {e}")
            self._send_json({
                "ok": False,
                "error": f"Worktree error: {e}",
                "output": "\n".join(output_lines),
            }, status=400)

        except Exception as e:
            output_lines.append(f"Error: {e}")
            self._send_json({
                "ok": False,
                "error": f"Failed to initialize: {e}",
                "output": "\n".join(output_lines),
            }, status=500)

    def _handle_select_issue(self):
        """Handle POST /api/issues/select - Select an issue as active."""
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json(
                {
                    "ok": False,
                    "error": "Issue selection is only allowed from localhost.",
                },
                status=403,
            )
            return

        if self.run_manager.get_status().get("running"):
            self._send_json({"ok": False, "error": "Cannot change issue while Jeeves is running."}, status=409)
            return

        body = self._read_json_body()
        issue_ref = body.get("issue_ref", "").strip()

        if not issue_ref:
            self._send_json({"ok": False, "error": "issue_ref is required"}, status=400)
            return

        try:
            # Parse and validate
            owner, repo, issue_number = parse_issue_ref(issue_ref)

            # Check if issue exists
            state_dir = get_issue_state_dir(owner, repo, issue_number)
            if not (state_dir / "issue.json").exists():
                self._send_json({
                    "ok": False,
                    "error": f"Issue not initialized. Run: jeeves init --repo {owner}/{repo} --issue {issue_number}"
                }, status=404)
                return

            # Set as active
            self.run_manager.set_issue(issue_ref)
            save_active_issue(issue_ref)  # Persist for server restarts

            # Update the state tracker
            self.state.state_dir = self.run_manager.state_dir
            self.state.prd_file = self.state.state_dir / "prd.json"
            self.state.issue_file = self.state.state_dir / "issue.json"
            self.state.progress_file = self.state.state_dir / "progress.txt"
            self.state.last_run_log = self.state.state_dir / "last-run.log"
            self.state.viewer_run_log = self.state.state_dir / "viewer-run.log"

            # Load issue state to return info
            state = IssueState.load(owner, repo, issue_number)

            self._send_json({
                "ok": True,
                "issue_ref": issue_ref,
                "state_dir": str(state_dir),
                "worktree": str(get_worktree_path(owner, repo, issue_number)),
                "branch": state.branch,
                "issue_title": state.issue.title,
            })

        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
        except IssueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=404)
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to select issue: {e}"}, status=500)

    def _get_sdk_output_path(self) -> Path:
        """Get the SDK output file path."""
        return self.state.state_dir / "sdk-output.json"

    def _read_sdk_output(self) -> Optional[Dict]:
        """Read and parse SDK output JSON file."""
        sdk_path = self._get_sdk_output_path()
        if not sdk_path.exists():
            return None
        try:
            with open(sdk_path, "r") as f:
                return json.load(f)
        except Exception:
            return None

    def _handle_sdk_output(self):
        """Handle GET /api/sdk-output - Return full SDK output."""
        data = self._read_sdk_output()
        if data is None:
            self._send_json({"ok": False, "error": "SDK output not found"}, status=404)
            return
        self._send_json({"ok": True, "output": data})

    def _handle_sdk_output_messages(self):
        """Handle GET /api/sdk-output/messages - Return just the messages array."""
        data = self._read_sdk_output()
        if data is None:
            self._send_json({"ok": False, "error": "SDK output not found"}, status=404)
            return
        messages = data.get("messages", [])
        self._send_json({"ok": True, "messages": messages})

    def _handle_sdk_output_tool_calls(self):
        """Handle GET /api/sdk-output/tool-calls - Return tool call summary."""
        data = self._read_sdk_output()
        if data is None:
            self._send_json({"ok": False, "error": "SDK output not found"}, status=404)
            return
        tool_calls = data.get("tool_calls", [])
        stats = data.get("stats", {})
        self._send_json({
            "ok": True,
            "tool_calls": tool_calls,
            "stats": {
                "tool_call_count": stats.get("tool_call_count", len(tool_calls)),
                "duration_seconds": stats.get("duration_seconds", 0),
            }
        })

    def _handle_list_issues(self):
        """Handle GET /api/issues - List all issues from central data directory."""
        issues = list_issues_from_jeeves()
        data_dir = get_data_dir()
        self._send_json({
            "ok": True,
            "issues": issues,
            "data_dir": str(data_dir) if data_dir else None,
            "count": len(issues),
            "current_issue": self.run_manager.issue_ref,
        })

    def _handle_workflow(self):
        """Handle GET /api/workflow - Return workflow phases for the current issue."""
        # Load issue.json to get workflow name
        issue_file = self.state.issue_file
        workflow_name = "default"
        current_phase = "design_draft"

        if issue_file.exists():
            try:
                with open(issue_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                workflow_name = data.get("workflow", "default")
                current_phase = data.get("phase", "design_draft")
            except Exception:
                pass

        try:
            workflow = load_workflow_by_name(workflow_name)
        except FileNotFoundError:
            self._send_json({
                "ok": False,
                "error": f"Workflow '{workflow_name}' not found",
            }, status=404)
            return
        except Exception as e:
            self._send_json({
                "ok": False,
                "error": f"Failed to load workflow: {e}",
            }, status=500)
            return

        # Build phases list
        phases = []
        for phase_id, phase in workflow.phases.items():
            phases.append({
                "id": phase_id,
                "name": phase_id.replace("_", " ").title(),
                "type": phase.type.value if hasattr(phase.type, 'value') else str(phase.type),
                "description": phase.description or "",
            })

        # Sort phases by workflow order (start phase first, then follow transitions)
        # For now, we'll use a simple ordering based on the workflow's defined order
        phase_order = list(workflow.phases.keys())

        self._send_json({
            "ok": True,
            "workflow_name": workflow_name,
            "start_phase": workflow.start,
            "current_phase": current_phase,
            "phases": phases,
            "phase_order": phase_order,
        })

    def _handle_workflows_list(self):
        """Handle GET /api/workflows - List all workflow files."""
        workflows = self.workflow_manager.list_workflows()
        self._send_json({"ok": True, "workflows": workflows})

    def _handle_workflow_get_full(self, name: str):
        """Handle GET /api/workflow/{name}/full - Get complete workflow JSON."""
        try:
            data = self.workflow_manager.get_workflow_full(name)
            self._send_json({"ok": True, **data})
        except FileNotFoundError as e:
            self._send_json({"ok": False, "error": str(e)}, status=404)
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to load workflow: {e}"}, status=500)

    def _handle_workflow_save(self, name: str):
        """Handle POST /api/workflow/{name} - Save workflow to YAML file."""
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json({
                "ok": False,
                "error": "Workflow editing is only allowed from localhost.",
            }, status=403)
            return

        body = self._read_json_body()
        workflow_data = body.get("workflow", body)  # Accept both {workflow: {...}} and direct data

        # Ensure we have the workflow wrapper
        if "workflow" not in workflow_data and "phases" in workflow_data:
            # Direct data format - wrap it
            pass
        elif "workflow" in workflow_data:
            # Already wrapped
            workflow_data = workflow_data

        try:
            self.workflow_manager.save_workflow(name, workflow_data)
            self._send_json({"ok": True, "name": name})
        except FileNotFoundError as e:
            self._send_json({"ok": False, "error": str(e)}, status=404)
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to save workflow: {e}"}, status=500)

    def _handle_workflow_validate(self, name: str):
        """Handle POST /api/workflow/{name}/validate - Validate workflow without saving."""
        body = self._read_json_body()
        workflow_data = body.get("workflow", body)

        errors = self.workflow_manager.validate_workflow(workflow_data)

        self._send_json({
            "ok": True,
            "valid": len(errors) == 0,
            "errors": errors,
        })

    def _handle_workflow_duplicate(self, source_name: str):
        """Handle POST /api/workflow/{name}/duplicate - Create copy of workflow."""
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json({
                "ok": False,
                "error": "Workflow editing is only allowed from localhost.",
            }, status=403)
            return

        body = self._read_json_body()
        target_name = body.get("target_name", "").strip()

        if not target_name:
            self._send_json({"ok": False, "error": "target_name is required"}, status=400)
            return

        try:
            new_name = self.workflow_manager.duplicate_workflow(source_name, target_name)
            self._send_json({"ok": True, "name": new_name})
        except FileNotFoundError as e:
            self._send_json({"ok": False, "error": str(e)}, status=404)
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to duplicate workflow: {e}"}, status=500)

    def _handle_workflow_delete(self, name: str):
        """Handle DELETE /api/workflow/{name} - Delete workflow file."""
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json({
                "ok": False,
                "error": "Workflow deletion is only allowed from localhost.",
            }, status=403)
            return

        try:
            self.workflow_manager.delete_workflow(name)
            self._send_json({"ok": True})
        except FileNotFoundError as e:
            self._send_json({"ok": False, "error": str(e)}, status=404)
        except ValueError as e:
            self._send_json({"ok": False, "error": str(e)}, status=400)
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to delete workflow: {e}"}, status=500)

    def _handle_status_fields(self):
        """Handle GET /api/status-fields - Return known status field names."""
        fields = self.workflow_manager.get_status_fields()
        self._send_json({"ok": True, "fields": fields})

    def _handle_data_dir_info(self):
        """Handle GET /api/data-dir - Get info about the central data directory."""
        data_dir = get_data_dir()

        if not data_dir:
            self._send_json({
                "ok": False,
                "error": "Cannot determine data directory",
            }, status=500)
            return

        info = {
            "ok": True,
            "data_dir": str(data_dir),
            "exists": data_dir.exists(),
            "repos_dir": str(data_dir / "repos"),
            "worktrees_dir": str(data_dir / "worktrees"),
            "issues_dir": str(data_dir / "issues"),
        }

        if data_dir.exists():
            repos_dir = data_dir / "repos"
            worktrees_dir = data_dir / "worktrees"
            issues_dir = data_dir / "issues"

            if repos_dir.exists():
                try:
                    info["repo_count"] = sum(1 for _ in repos_dir.glob("*/*") if _.is_dir())
                except Exception:
                    info["repo_count"] = 0

            if worktrees_dir.exists():
                try:
                    info["worktree_count"] = sum(1 for _ in worktrees_dir.glob("*/*/issue-*") if _.is_dir())
                except Exception:
                    info["worktree_count"] = 0

            if issues_dir.exists():
                try:
                    info["issue_count"] = sum(1 for _ in issues_dir.glob("*/*/*/issue.json"))
                except Exception:
                    info["issue_count"] = 0

        self._send_json(info)

    def _send_json(self, data: Dict, status: int = 200):
        """Send JSON response"""
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
    
    def _handle_sse(self):
        """Handle Server-Sent Events for real-time updates"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")  # Disable nginx buffering
        self.end_headers()

        try:
            current_log_path = self.state._get_log_path()
            log_watcher = LogWatcher(current_log_path)

            # SDK output watcher for real-time SDK streaming
            sdk_output_path = self._get_sdk_output_path()
            sdk_watcher = SDKOutputWatcher(sdk_output_path)
            sdk_session_started = False
            sdk_session_ended = False
            last_sdk_session_id: Optional[str] = None

            def state_signature(state: Dict) -> str:
                signature_state = copy.deepcopy(state)
                signature_state.pop("timestamp", None)
                signature_state.pop("recent_logs", None)
                return json.dumps(signature_state, sort_keys=True)

            # Send initial padding to help proxies/browsers start rendering immediately
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()

            # Send initial state
            state = self.state.get_state(force=True, include_recent_logs=False)
            state["recent_logs"] = log_watcher.get_all_lines(500)
            state["run"] = self.run_manager.get_status()
            self._sse_send("state", state)

            # Send initial SDK state if SDK output exists
            sdk_data = self._read_sdk_output()
            if sdk_data:
                session_id = sdk_data.get("session_id")
                if session_id:
                    last_sdk_session_id = session_id
                    sdk_session_started = True
                    # Send sdk-init event
                    self._sse_send("sdk-init", {
                        "session_id": session_id,
                        "started_at": sdk_data.get("started_at"),
                        "status": "complete" if sdk_data.get("ended_at") else "running"
                    })

                # Send initial messages as sdk-message events
                messages = sdk_data.get("messages", [])
                for idx, msg in enumerate(messages):
                    self._sse_send("sdk-message", {
                        "message": msg,
                        "index": idx,
                        "total": len(messages)
                    })

                # Send tool calls as sdk-tool-start and sdk-tool-complete events
                tool_calls = sdk_data.get("tool_calls", [])
                for tool_call in tool_calls:
                    # Send sdk-tool-start event first (tool invocation begins)
                    self._sse_send("sdk-tool-start", {
                        "tool_use_id": tool_call.get("tool_use_id"),
                        "name": tool_call.get("name"),
                        "input": tool_call.get("input", {})
                    })
                    # Then send sdk-tool-complete event (tool returns)
                    self._sse_send("sdk-tool-complete", {
                        "tool_use_id": tool_call.get("tool_use_id"),
                        "name": tool_call.get("name"),
                        "duration_ms": tool_call.get("duration_ms", 0),
                        "is_error": tool_call.get("is_error", False)
                    })

                # Update watcher to track from current position
                sdk_watcher.get_updates()

                # Send sdk-complete if session already ended
                if sdk_data.get("ended_at"):
                    sdk_session_ended = True
                    self._sse_send("sdk-complete", {
                        "status": "success" if sdk_data.get("success", True) else "error",
                        "summary": sdk_data.get("stats", {})
                    })

            last_state_sig = state_signature(state)
            heartbeat_interval = 15  # Send heartbeat every 15s
            last_heartbeat = time.time()
            state_poll_interval = 0.5  # 500ms state polling
            last_state_check = time.time()
            sdk_poll_interval = 0.1  # 100ms SDK polling (same as logs)
            last_sdk_check = time.time()

            while True:
                # Check if log path changed (issue was changed)
                next_log_path = self.state._get_log_path()
                if next_log_path != current_log_path:
                    current_log_path = next_log_path
                    log_watcher = LogWatcher(current_log_path)
                    # Send all lines from new log file
                    new_logs = log_watcher.get_all_lines(500)
                    if new_logs:
                        self._sse_send("logs", {"lines": new_logs, "reset": True})

                    # Reset SDK watcher for new issue
                    sdk_output_path = self._get_sdk_output_path()
                    sdk_watcher = SDKOutputWatcher(sdk_output_path)
                    sdk_session_started = False
                    sdk_session_ended = False
                    last_sdk_session_id = None

                # Check for new log lines (fast poll - 100ms)
                new_logs, has_logs = log_watcher.get_new_lines()
                if has_logs and new_logs:
                    self._sse_send("logs", {"lines": new_logs})

                # Check for SDK updates (fast poll - 100ms)
                now = time.time()
                if now - last_sdk_check >= sdk_poll_interval:
                    new_messages, new_tool_calls, has_sdk_changes = sdk_watcher.get_updates()

                    if has_sdk_changes:
                        # Check if this is a new session
                        sdk_data = self._read_sdk_output()
                        if sdk_data:
                            session_id = sdk_data.get("session_id")

                            # Send sdk-init if new session detected
                            if session_id and session_id != last_sdk_session_id:
                                last_sdk_session_id = session_id
                                sdk_session_started = True
                                sdk_session_ended = False
                                self._sse_send("sdk-init", {
                                    "session_id": session_id,
                                    "started_at": sdk_data.get("started_at"),
                                    "status": "running"
                                })

                            # Send sdk-message events for new messages
                            total_messages = len(sdk_data.get("messages", []))
                            start_idx = total_messages - len(new_messages)
                            for idx, msg in enumerate(new_messages):
                                self._sse_send("sdk-message", {
                                    "message": msg,
                                    "index": start_idx + idx,
                                    "total": total_messages
                                })

                            # Send sdk-tool-start and sdk-tool-complete events for new tool calls
                            for tool_call in new_tool_calls:
                                # Send sdk-tool-start event first (tool invocation begins)
                                self._sse_send("sdk-tool-start", {
                                    "tool_use_id": tool_call.get("tool_use_id"),
                                    "name": tool_call.get("name"),
                                    "input": tool_call.get("input", {})
                                })
                                # Then send sdk-tool-complete event (tool returns)
                                self._sse_send("sdk-tool-complete", {
                                    "tool_use_id": tool_call.get("tool_use_id"),
                                    "name": tool_call.get("name"),
                                    "duration_ms": tool_call.get("duration_ms", 0),
                                    "is_error": tool_call.get("is_error", False)
                                })

                            # Check if session ended
                            if sdk_data.get("ended_at") and not sdk_session_ended:
                                sdk_session_ended = True
                                self._sse_send("sdk-complete", {
                                    "status": "success" if sdk_data.get("success", True) else "error",
                                    "summary": sdk_data.get("stats", {})
                                })

                    last_sdk_check = now

                # Check for state changes (slower poll - 500ms)
                if now - last_state_check >= state_poll_interval:
                    state = self.state.get_state(include_recent_logs=False)
                    state["run"] = self.run_manager.get_status()
                    sig = state_signature(state)
                    if sig != last_state_sig:
                        self._sse_send("state", state)
                        last_state_sig = sig
                    last_state_check = now

                # Heartbeat to keep connection alive
                if now - last_heartbeat > heartbeat_interval:
                    self._sse_send("heartbeat", {"time": datetime.now().isoformat()})
                    last_heartbeat = now

                time.sleep(0.1)  # 100ms poll interval

        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            # Log unexpected errors
            print(f"SSE error: {e}")
    
    def _sse_send(self, event: str, data):
        """Send SSE event with proper formatting and flush"""
        try:
            msg = f"event: {event}\ndata: {json.dumps(data)}\n\n"
            self.wfile.write(msg.encode())
            self.wfile.flush()
        except Exception:
            raise ConnectionAbortedError()
    
    def log_message(self, format, *args):
        """Custom logging - only log errors"""
        if args and '404' in str(args[0]):
            print(f"[404] {args[0]}")

def main():
    parser = argparse.ArgumentParser(description="Jeeves Real-time Viewer")
    parser.add_argument("--port", "-p", type=int, default=8080, help="Port to serve on")
    parser.add_argument("--issue", "-i", type=str, help="Issue to work on (owner/repo#123)")
    parser.add_argument(
        "--allow-remote-run",
        action="store_true",
        help="Allow run control, init, and prompt edits from non-localhost clients (unsafe on untrusted networks).",
    )
    args = parser.parse_args()

    env_allow_remote = str(os.environ.get("JEEVES_VIEWER_ALLOW_REMOTE_RUN", "")).strip().lower() in {"1", "true", "yes", "on"}
    if env_allow_remote:
        args.allow_remote_run = True

    # Determine initial issue
    issue_ref = args.issue
    state_dir = None

    if issue_ref:
        try:
            owner, repo, issue_number = parse_issue_ref(issue_ref)
            state_dir = get_issue_state_dir(owner, repo, issue_number)
            if not (state_dir / "issue.json").exists():
                print(f"Warning: Issue {issue_ref} not initialized.")
                print(f"Run: jeeves init --repo {owner}/{repo} --issue {issue_number}")
                issue_ref = None
                state_dir = None
        except ValueError as e:
            print(f"Error: Invalid issue reference: {e}")
            return 1

    # If no issue specified, try to load the last active issue
    if not issue_ref:
        saved_issue = load_active_issue()
        if saved_issue:
            try:
                owner, repo, issue_number = parse_issue_ref(saved_issue)
                saved_state_dir = get_issue_state_dir(owner, repo, issue_number)
                if (saved_state_dir / "issue.json").exists():
                    issue_ref = saved_issue
                    state_dir = saved_state_dir
                    print(f"  Restored last active issue: {issue_ref}")
            except (ValueError, OSError):
                pass  # Invalid saved issue, will fall through to auto-select

    # If still no issue, try to find the most recent one
    if not issue_ref:
        issues = list_issues_from_jeeves()
        if issues:
            # Sort by mtime if available, otherwise use first
            sorted_issues = sorted(
                issues,
                key=lambda x: Path(x.get("state_dir", "")).stat().st_mtime if Path(x.get("state_dir", "")).exists() else 0,
                reverse=True
            )
            if sorted_issues:
                latest = sorted_issues[0]
                issue_ref = f"{latest['owner']}/{latest['repo']}#{latest['issue_number']}"
                state_dir = Path(latest["state_dir"])
                print(f"  Auto-selected most recent issue: {issue_ref}")
                save_active_issue(issue_ref)  # Save for future restarts

    # Create a default state dir if none found
    if not state_dir:
        data_dir = get_data_dir()
        state_dir = data_dir / "viewer-default"
        state_dir.mkdir(parents=True, exist_ok=True)

    print("")
    print("  Jeeves Real-time Viewer")
    print("  " + "=" * 40)
    print(f"  Data directory: {get_data_dir()}")
    if issue_ref:
        print(f"  Active issue: {issue_ref}")
        print(f"  State directory: {state_dir}")
    else:
        print("  No issue selected. Use /api/init/issue or /api/issues/select")
    print(f"  Server: http://localhost:{args.port}")
    print("")
    print("  Press Ctrl+C to stop")
    print("")

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # prompts/ and workflows/ directories are at repo root: src/jeeves/viewer/server.py -> src/jeeves/ -> src/ -> repo root
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    prompts_dir = repo_root / "prompts"
    workflows_dir = repo_root / "workflows"
    state = JeevesState(str(state_dir))
    run_manager = JeevesRunManager(issue_ref=issue_ref, prompts_dir=prompts_dir)
    prompt_manager = JeevesPromptManager(prompts_dir)
    workflow_manager = JeevesWorkflowManager(workflows_dir)

    def handler(*args_handler, **kwargs_handler):
        return JeevesViewerHandler(
            *args_handler,
            state=state,
            run_manager=run_manager,
            prompt_manager=prompt_manager,
            workflow_manager=workflow_manager,
            allow_remote_run=args.allow_remote_run,
            **kwargs_handler,
        )

    # SSE connections are long-lived; use a threaded server so one connected
    # dashboard doesn't block all other HTTP requests.
    server = ThreadingHTTPServer(("0.0.0.0", args.port), handler)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")

    return 0


if __name__ == "__main__":
    exit(main())
