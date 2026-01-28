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

# Import jeeves modules for the new CLI-based approach
try:
    from jeeves.paths import (
        get_data_dir,
        get_issue_state_dir,
        get_worktree_path,
        parse_issue_ref,
        parse_repo_spec,
    )
    from jeeves.issue import (
        IssueError,
        IssueState,
        create_issue_state,
        list_issues as list_issues_from_jeeves,
    )
    from jeeves.repo import ensure_repo, RepoError
    from jeeves.worktree import create_worktree, WorktreeError
    from jeeves.config import GlobalConfig
    JEEVES_CLI_AVAILABLE = True
except ImportError:
    JEEVES_CLI_AVAILABLE = False


class JeevesPromptManager:
    """Read/write Jeeves prompt templates stored alongside jeeves.sh."""

    def __init__(self, prompt_dir: Path):
        self.prompt_dir = prompt_dir.resolve()
        self._lock = Lock()

    def list_prompts(self) -> List[Dict]:
        prompts: List[Dict] = []
        try:
            for path in sorted(self.prompt_dir.glob("prompt*.md")):
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
        if not prompt_id.startswith("prompt") or not prompt_id.endswith(".md"):
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


class JeevesState:
    """Track Jeeves's current state from files"""
    
    def __init__(self, state_dir: str):
        self.state_dir = Path(state_dir)
        self.prd_file = self.state_dir / "prd.json"
        self.issue_file = self.state_dir / "issue.json"
        self.progress_file = self.state_dir / "progress.txt"
        self.last_run_log = self.state_dir / "last-run.log"
        self.last_message = self.state_dir / "last-message.txt"
        self.coverage_failures = self.state_dir / "coverage-failures.md"
        self.open_questions = self.state_dir / "open-questions.md"
        
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
        files = [self.prd_file, self.issue_file, self.progress_file, 
                 self.last_run_log, self.coverage_failures, self.open_questions]
        
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
            status = config.get("status", {})
            pr = config.get("pullRequest", {})
            issue = config.get("issue", {})

            has_coverage_failures = self.coverage_failures.exists() and self.coverage_failures.stat().st_size > 0
            has_open_questions = self.open_questions.exists() and self.open_questions.stat().st_size > 0

            coverage_needs_fix = bool(status.get("coverageNeedsFix", False) or has_coverage_failures)
            coverage_clean = bool(status.get("coverageClean", False) and not coverage_needs_fix)
            
            # Get current task info
            tasks = config.get("tasks") or []
            current_task_id = status.get("currentTaskId")
            current_task = None
            tasks_done_count = 0
            for i, t in enumerate(tasks):
                if (t.get("status") or "pending") == "done":
                    tasks_done_count += 1
                if current_task_id and t.get("id") == current_task_id:
                    current_task = {
                        "id": t.get("id"),
                        "index": i + 1,
                        "title": t.get("title", ""),
                        "summary": t.get("summary", ""),
                    }

            state["status"] = {
                "phase": self._determine_phase(config, status),
                "implemented": status.get("implemented", False),
                "pr_created": status.get("prCreated", False) or bool(pr.get("number")),
                "pr_description_ready": status.get("prDescriptionReady", False),
                "pr_number": pr.get("number"),
                "pr_url": pr.get("url"),
                "review_clean": status.get("reviewClean", False),
                "ci_clean": status.get("ciClean", False),
                "coverage_clean": coverage_clean,
                "coverage_needs_fix": coverage_needs_fix,
                "sonar_clean": status.get("sonarClean", False),
                "has_coverage_failures": has_coverage_failures,
                "has_open_questions": has_open_questions,
                "issue_number": issue.get("number") or config.get("issueNumber"),
                "issue_url": issue.get("url"),
                "issue_title": issue.get("title", ""),
                "branch_name": config.get("branchName"),
                "design_doc": config.get("designDocPath") or config.get("designDoc"),
                "current_task": current_task,
                "tasks_total": len(tasks),
                "tasks_done": tasks_done_count,
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

    def get_recent_logs(self, max_lines: int = 500) -> List[str]:
        """Read last N log lines without affecting SSE streaming cursor."""
        if not self.last_run_log.exists():
            return []
        return self._read_lines_tail(self.last_run_log, max_lines)
    
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
    
    def _determine_phase(self, config: Dict, status: Dict) -> str:
        """Determine current phase from config"""
        implemented = status.get("implemented", False)
        pr_created = status.get("prCreated", False) or config.get("pullRequest", {}).get("number")
        pr_desc_ready = status.get("prDescriptionReady", False)
        review_clean = status.get("reviewClean", False)
        ci_clean = status.get("ciClean", False)
        has_coverage_failures = self.coverage_failures.exists() and self.coverage_failures.stat().st_size > 0
        coverage_needs_fix = bool(status.get("coverageNeedsFix", False) or has_coverage_failures)
        coverage_clean = bool(status.get("coverageClean", False) and not coverage_needs_fix)
        sonar_clean = status.get("sonarClean", False)
        has_open_questions = self.open_questions.exists() and self.open_questions.stat().st_size > 0
        tasks = config.get("tasks") or []
        has_tasks = len(tasks) > 0
        task_stage = status.get("taskStage") or "implement"
        tasks_complete = status.get("tasksComplete")
        if tasks_complete is None and has_tasks:
            tasks_complete = all((task.get("status") or "pending") == "done" for task in tasks)
        tasks_complete = bool(tasks_complete) if has_tasks else False

        # Check if design doc exists on disk (matches jeeves.sh behavior)
        design_doc = config.get("designDocPath") or config.get("designDoc")
        has_design_doc = False
        if design_doc:
            design_doc_path = Path(design_doc)
            if not design_doc_path.is_absolute():
                design_doc_path = self.state_dir.parent / design_doc
            has_design_doc = design_doc_path.exists()

        if not has_design_doc:
            return "design"
        if has_tasks and not tasks_complete:
            if task_stage == "spec-review":
                return "task-spec-review"
            if task_stage == "quality-review":
                return "task-quality-review"
            return "task-implement"
        if implemented and pr_created and pr_desc_ready and has_open_questions:
            return "questions"
        if not (implemented and pr_created and pr_desc_ready):
            return "implement"
        if not review_clean:
            return "review"
        if not ci_clean:
            return "ci"
        if coverage_needs_fix:
            return "coverage-fix"
        if not coverage_clean:
            return "coverage"
        if not sonar_clean:
            return "sonar"
        return "complete"
    
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
    """Start/stop Jeeves runs from the viewer (single run at a time)."""

    def __init__(self, *, issue_ref: Optional[str] = None, state_dir: Optional[Path] = None):
        """Initialize the run manager.

        Args:
            issue_ref: Issue reference in "owner/repo#123" format.
            state_dir: State directory (derived from issue_ref if not provided).
        """
        self.issue_ref = issue_ref
        self._owner: Optional[str] = None
        self._repo: Optional[str] = None
        self._issue_number: Optional[int] = None

        if issue_ref and JEEVES_CLI_AVAILABLE:
            self._owner, self._repo, self._issue_number = parse_issue_ref(issue_ref)
            self.state_dir = get_issue_state_dir(self._owner, self._repo, self._issue_number)
            self.work_dir = get_worktree_path(self._owner, self._repo, self._issue_number)
        elif state_dir:
            self.state_dir = state_dir.resolve()
            self.work_dir = self.state_dir.parent
        else:
            # Default empty state for when no issue is selected
            self.state_dir = Path.cwd() / "jeeves"
            self.work_dir = Path.cwd()

        self._lock = Lock()
        self._proc: Optional[subprocess.Popen] = None
        self._run_info: Dict = {
            "running": False,
            "pid": None,
            "started_at": None,
            "ended_at": None,
            "returncode": None,
            "command": None,
            "runner": None,
            "max_iterations": None,
            "output_mode": None,
            "prompt_append_file": None,
            "viewer_log_file": str(self.state_dir / "viewer-run.log"),
            "last_error": None,
            "issue_ref": issue_ref,
        }

    def set_issue(self, issue_ref: str) -> None:
        """Set the active issue.

        Args:
            issue_ref: Issue reference in "owner/repo#123" format.
        """
        if not JEEVES_CLI_AVAILABLE:
            raise RuntimeError("Jeeves CLI modules not available")

        self._owner, self._repo, self._issue_number = parse_issue_ref(issue_ref)
        self.issue_ref = issue_ref
        self.state_dir = get_issue_state_dir(self._owner, self._repo, self._issue_number)
        self.work_dir = get_worktree_path(self._owner, self._repo, self._issue_number)
        self._run_info["viewer_log_file"] = str(self.state_dir / "viewer-run.log")
        self._run_info["issue_ref"] = issue_ref

    def get_status(self) -> Dict:
        with self._lock:
            proc = self._proc
            if proc is not None and proc.poll() is None:
                self._run_info["running"] = True
                self._run_info["pid"] = proc.pid
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

    def _write_prompt_append(self, prompt_append: str) -> Optional[Path]:
        """Write prompt append content to a state file; returns path or None if empty."""
        prompt_append = (prompt_append or "").strip()
        append_path = self.state_dir / "viewer-prompt.append.md"
        if not prompt_append:
            try:
                append_path.unlink(missing_ok=True)  # py3.8+
            except TypeError:  # pragma: no cover (py37)
                if append_path.exists():
                    append_path.unlink()
            return None
        append_path.parent.mkdir(parents=True, exist_ok=True)
        append_path.write_text(prompt_append + "\n")
        return append_path

    def start(
        self,
        *,
        runner: str = "auto",
        max_iterations: int = 10,
        mode: str = "auto",
        output_mode: str = "stream",
        print_prompt: bool = False,
        prompt_append: str = "",
        env_overrides: Optional[Dict[str, str]] = None,
    ) -> Dict:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                raise RuntimeError("Jeeves is already running")

            if not JEEVES_CLI_AVAILABLE:
                raise RuntimeError("Jeeves CLI modules not available")

            if not self.issue_ref:
                raise ValueError("No issue selected. Use /api/issues/select first.")

            if runner not in {"auto", "codex", "claude", "opencode", "sdk"}:
                raise ValueError("runner must be one of: auto, codex, claude, opencode, sdk")

            try:
                max_iterations_int = int(max_iterations)
            except Exception as e:
                raise ValueError("max_iterations must be an integer") from e
            if max_iterations_int < 1 or max_iterations_int > 10_000:
                raise ValueError("max_iterations must be between 1 and 10000")

            if mode not in {"auto", "issue", "prd"}:
                raise ValueError("mode must be one of: auto, issue, prd")

            if output_mode not in {"stream", "compact"}:
                raise ValueError("output_mode must be one of: stream, compact")

            # Verify worktree exists
            if not self.work_dir.exists():
                raise FileNotFoundError(
                    f"Worktree not found at {self.work_dir}. "
                    f"Run: jeeves init --repo {self._owner}/{self._repo} --issue {self._issue_number}"
                )

            viewer_log_path = Path(self._run_info["viewer_log_file"])
            viewer_log_path.parent.mkdir(parents=True, exist_ok=True)
            viewer_log_path.write_text("")

            append_path = self._write_prompt_append(prompt_append)

            env = os.environ.copy()
            env["JEEVES_STATE_DIR"] = str(self.state_dir)
            env["JEEVES_WORK_DIR"] = str(self.work_dir)
            env["JEEVES_MODE"] = mode
            env["JEEVES_OUTPUT_MODE"] = output_mode
            env["JEEVES_PRINT_PROMPT"] = "1" if print_prompt else "0"

            if runner != "auto":
                env["JEEVES_RUNNER"] = runner

            # Codex often needs fully unsandboxed execution to access installed skills
            # and repo tooling like `gh`. Default to dangerous mode when using Codex.
            # (Callers can still override via explicit env_overrides.)
            if runner in {"auto", "codex"} and "JEEVES_CODEX_DANGEROUS" not in (env_overrides or {}):
                env["JEEVES_CODEX_DANGEROUS"] = "1"

            if append_path is not None:
                env["JEEVES_PROMPT_APPEND_FILE"] = str(append_path)
            else:
                env.pop("JEEVES_PROMPT_APPEND_FILE", None)

            if env_overrides:
                for key, value in env_overrides.items():
                    if not isinstance(key, str) or not isinstance(value, str):
                        continue
                    if not key.startswith("JEEVES_"):
                        continue
                    env[key] = value

            # Build command using `python -m jeeves.cli run`
            cmd: List[str] = [
                sys.executable, "-m", "jeeves.cli", "run",
                self.issue_ref,
                "--max-iterations", str(max_iterations_int),
            ]
            if runner != "auto":
                cmd += ["--runner", runner]

            started_at = datetime.now().isoformat()

            log_file = open(viewer_log_path, "a", buffering=1)
            try:
                proc = subprocess.Popen(
                    cmd,
                    cwd=str(self.work_dir),
                    env=env,
                    stdout=log_file,
                    stderr=log_file,
                    start_new_session=True,
                    text=True,
                )
            finally:
                log_file.close()

            self._proc = proc
            self._run_info = {
                "running": True,
                "pid": proc.pid,
                "started_at": started_at,
                "ended_at": None,
                "returncode": None,
                "command": cmd,
                "runner": runner,
                "max_iterations": max_iterations_int,
                "output_mode": output_mode,
                "prompt_append_file": str(append_path) if append_path else None,
                "viewer_log_file": str(viewer_log_path),
                "last_error": None,
                "issue_ref": self.issue_ref,
            }

            Thread(target=self._wait_for_exit, args=(proc,), daemon=True).start()
            return copy.deepcopy(self._run_info)

    def _wait_for_exit(self, proc: subprocess.Popen):
        try:
            returncode = proc.wait()
        except Exception:
            returncode = None
        ended_at = datetime.now().isoformat()
        with self._lock:
            if self._proc is proc:
                self._run_info["running"] = False
                self._run_info["pid"] = None
                self._run_info["ended_at"] = ended_at
                self._run_info["returncode"] = returncode

    def stop(self, *, force: bool = False, timeout_sec: float = 5.0) -> Dict:
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                return copy.deepcopy(self._run_info)

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
        allow_remote_run: bool = False,
        **kwargs,
    ):
        self.state = state
        self.run_manager = run_manager
        self.prompt_manager = prompt_manager
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
        
        if path == "/":
            path = "/index.html"
        
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
        if path == "/api/git/update-main":
            self._handle_git_update_main()
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

        self.send_error(404, "Not Found")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

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
                # Update the state tracker to point to the new state dir
                self.state.state_dir = self.run_manager.state_dir
                self.state.prd_file = self.state.state_dir / "prd.json"
                self.state.issue_file = self.state.state_dir / "issue.json"
                self.state.progress_file = self.state.state_dir / "progress.txt"
                self.state.last_run_log = self.state.state_dir / "last-run.log"
                self.state.last_message = self.state.state_dir / "last-message.txt"
                self.state.coverage_failures = self.state.state_dir / "coverage-failures.md"
                self.state.open_questions = self.state.state_dir / "open-questions.md"
            except ValueError as e:
                self._send_json({"ok": False, "error": str(e), "run": self.run_manager.get_status()}, status=400)
                return
            except Exception as e:
                self._send_json({"ok": False, "error": f"Failed to select issue: {e}", "run": self.run_manager.get_status()}, status=500)
                return

        runner = body.get("runner", "auto")
        max_iterations = body.get("max_iterations", 10)
        mode = body.get("mode", "auto")
        output_mode = body.get("output_mode", "stream")
        print_prompt = bool(body.get("print_prompt", False))
        prompt_append = body.get("prompt_append", "")
        env_overrides = body.get("env", None)

        try:
            run_info = self.run_manager.start(
                runner=runner,
                max_iterations=max_iterations,
                mode=mode,
                output_mode=output_mode,
                print_prompt=print_prompt,
                prompt_append=prompt_append,
                env_overrides=env_overrides,
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
        updates = body.get("updates", None)
        if updates is None:
            key = body.get("key", None)
            value = body.get("value", None)
            if key:
                updates = {key: value}

        if not isinstance(updates, dict) or not updates:
            self._send_json({"ok": False, "error": "updates must be a non-empty object."}, status=400)
            return

        allowed = {
            "implemented",
            "prCreated",
            "prDescriptionReady",
            "reviewClean",
            "ciClean",
            "coverageClean",
            "coverageNeedsFix",
            "sonarClean",
        }
        normalized: Dict[str, bool] = {}
        for key, value in updates.items():
            if key not in allowed:
                self._send_json({"ok": False, "error": f"Unsupported status field: {key}"}, status=400)
                return
            if not isinstance(value, bool):
                self._send_json({"ok": False, "error": f"Status field {key} must be boolean."}, status=400)
                return
            normalized[key] = value

        try:
            raw = issue_file.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to read issue.json: {e}"}, status=500)
            return

        status = data.get("status", {})
        if not isinstance(status, dict):
            status = {}

        for key, value in normalized.items():
            status[key] = value

        # Make coverage toggles "effective" by keeping related signals in sync.
        if normalized.get("coverageClean") is True:
            if "coverageNeedsFix" not in normalized:
                status["coverageNeedsFix"] = False
            try:
                self.state.coverage_failures.unlink()
            except FileNotFoundError:
                pass
            except Exception:
                try:
                    self.state.coverage_failures.write_text("")
                except Exception:
                    pass

        if normalized.get("coverageNeedsFix") is False:
            try:
                self.state.coverage_failures.unlink()
            except FileNotFoundError:
                pass
            except Exception:
                try:
                    self.state.coverage_failures.write_text("")
                except Exception:
                    pass

        data["status"] = status

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

        self._send_json({"ok": True, "status": status})

    def _handle_git_update_main(self):
        if not self.allow_remote_run and not self._is_local_request():
            self._send_json(
                {
                    "ok": False,
                    "error": "Git operations are only allowed from localhost. Restart the viewer with --allow-remote-run to enable it.",
                },
                status=403,
            )
            return

        if self.run_manager.get_status().get("running"):
            self._send_json({"ok": False, "error": "Cannot update main while Jeeves is running."}, status=409)
            return

        body = self._read_json_body()
        remote = str(body.get("remote", "origin") or "origin").strip()
        branch = str(body.get("branch", "") or "").strip()
        force = bool(body.get("force", False))

        work_dir = self.run_manager.work_dir
        commands: List[Dict] = []

        def run(cmd: List[str], *, timeout_sec: float = 60.0) -> subprocess.CompletedProcess:
            try:
                proc = subprocess.run(
                    cmd,
                    cwd=str(work_dir),
                    capture_output=True,
                    text=True,
                    timeout=timeout_sec,
                )
            except subprocess.TimeoutExpired as e:
                commands.append(
                    {
                        "cmd": cmd,
                        "returncode": None,
                        "stdout": (e.stdout or ""),
                        "stderr": (e.stderr or ""),
                        "timeout": True,
                    }
                )
                raise
            commands.append(
                {
                    "cmd": cmd,
                    "returncode": proc.returncode,
                    "stdout": proc.stdout or "",
                    "stderr": proc.stderr or "",
                }
            )
            return proc

        def fail(message: str, *, status: int = 400):
            self._send_json(
                {
                    "ok": False,
                    "error": message,
                    "commands": commands,
                },
                status=status,
            )

        try:
            root = run(["git", "rev-parse", "--show-toplevel"])
        except subprocess.TimeoutExpired:
            fail("git command timed out", status=504)
            return
        except Exception as e:
            fail(f"Failed to run git: {e}", status=500)
            return

        if root.returncode != 0:
            fail("Not a git repository (or git not available).", status=400)
            return

        current_branch = ""
        proc_branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
        if proc_branch.returncode == 0:
            current_branch = (proc_branch.stdout or "").strip()

        if not branch:
            proc_default = run(["git", "symbolic-ref", f"refs/remotes/{remote}/HEAD"])
            if proc_default.returncode == 0:
                ref = (proc_default.stdout or "").strip()
                prefix = f"refs/remotes/{remote}/"
                if ref.startswith(prefix):
                    branch = ref[len(prefix):]
            if not branch:
                branch = "main"

        proc_remote = run(["git", "remote", "get-url", remote])
        if proc_remote.returncode != 0:
            fail(f"Remote '{remote}' not configured.", status=400)
            return

        proc_dirty = run(["git", "status", "--porcelain"])
        dirty = bool((proc_dirty.stdout or "").strip())
        if dirty and not force:
            fail("Working tree has uncommitted changes; refusing to switch branches.", status=409)
            return

        proc_fetch = run(["git", "fetch", "--prune", remote])
        if proc_fetch.returncode != 0:
            fail(f"Failed to fetch from '{remote}'.", status=400)
            return

        if current_branch != branch:
            proc_local = run(["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"])
            local_exists = proc_local.returncode == 0
            proc_remote_ref = run(["git", "show-ref", "--verify", "--quiet", f"refs/remotes/{remote}/{branch}"])
            remote_exists = proc_remote_ref.returncode == 0

            if local_exists:
                proc_checkout = run(["git", "checkout", branch])
            elif remote_exists:
                proc_checkout = run(["git", "checkout", "-b", branch, "--track", f"{remote}/{branch}"])
            else:
                fail(f"Branch '{branch}' not found locally or on '{remote}'.", status=400)
                return

            if proc_checkout.returncode != 0:
                fail(f"Failed to checkout '{branch}'.", status=400)
                return

        proc_merge = run(["git", "merge", "--ff-only", f"{remote}/{branch}"])
        if proc_merge.returncode != 0:
            if force:
                proc_reset = run(["git", "reset", "--hard", f"{remote}/{branch}"])
                if proc_reset.returncode != 0:
                    fail(f"Failed to reset '{branch}' to '{remote}/{branch}'.", status=400)
                    return
            else:
                fail(f"Failed to fast-forward '{branch}' (not a fast-forward?).", status=409)
                return

        proc_head = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
        proc_sha = run(["git", "rev-parse", "HEAD"])

        self._send_json(
            {
                "ok": True,
                "branch": (proc_head.stdout or "").strip() if proc_head.returncode == 0 else None,
                "commit": (proc_sha.stdout or "").strip() if proc_sha.returncode == 0 else None,
                "commands": commands,
            }
        )

    def _handle_init_issue_script_info(self):
        """Return info about init capability (for backward compatibility)."""
        self._send_json({
            "ok": True,
            "script": {
                "path": "jeeves.cli",
                "exists": JEEVES_CLI_AVAILABLE,
                "method": "python-module"
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

        if not JEEVES_CLI_AVAILABLE:
            self._send_json({"ok": False, "error": "Jeeves CLI modules not available"}, status=500)
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
                branch=state.branch_name,
            )
            output_lines.append(f"  Worktree: {worktree_path}")
            output_lines.append(f"  Branch: {state.branch_name}")

            # Set this as the active issue
            issue_ref = f"{owner}/{repo_name}#{issue_number}"
            self.run_manager.set_issue(issue_ref)

            # Update the state tracker
            self.state.state_dir = self.run_manager.state_dir
            self.state.prd_file = self.state.state_dir / "prd.json"
            self.state.issue_file = self.state.state_dir / "issue.json"
            self.state.progress_file = self.state.state_dir / "progress.txt"
            self.state.last_run_log = self.state.state_dir / "last-run.log"
            self.state.last_message = self.state.state_dir / "last-message.txt"
            self.state.coverage_failures = self.state.state_dir / "coverage-failures.md"
            self.state.open_questions = self.state.state_dir / "open-questions.md"

            output_lines.append("")
            output_lines.append(f"Ready! Run: jeeves run {issue_ref}")

            self._send_json({
                "ok": True,
                "issue_ref": issue_ref,
                "state_dir": str(state.state_dir),
                "worktree": str(worktree_path),
                "branch": state.branch_name,
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

        if not JEEVES_CLI_AVAILABLE:
            self._send_json({"ok": False, "error": "Jeeves CLI modules not available"}, status=500)
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

            # Update the state tracker
            self.state.state_dir = self.run_manager.state_dir
            self.state.prd_file = self.state.state_dir / "prd.json"
            self.state.issue_file = self.state.state_dir / "issue.json"
            self.state.progress_file = self.state.state_dir / "progress.txt"
            self.state.last_run_log = self.state.state_dir / "last-run.log"
            self.state.last_message = self.state.state_dir / "last-message.txt"
            self.state.coverage_failures = self.state.state_dir / "coverage-failures.md"
            self.state.open_questions = self.state.state_dir / "open-questions.md"

            # Load issue state to return info
            state = IssueState.load(owner, repo, issue_number)

            self._send_json({
                "ok": True,
                "issue_ref": issue_ref,
                "state_dir": str(state_dir),
                "worktree": str(get_worktree_path(owner, repo, issue_number)),
                "branch": state.branch_name,
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
        if JEEVES_CLI_AVAILABLE:
            issues = list_issues_from_jeeves()
            data_dir = get_data_dir()
        else:
            issues = list_central_issues()
            data_dir = get_jeeves_data_dir()
        self._send_json({
            "ok": True,
            "issues": issues,
            "data_dir": str(data_dir) if data_dir else None,
            "count": len(issues),
            "current_issue": self.run_manager.issue_ref,
        })

    def _handle_data_dir_info(self):
        """Handle GET /api/data-dir - Get info about the central data directory."""
        if JEEVES_CLI_AVAILABLE:
            data_dir = get_data_dir()
        else:
            data_dir = get_jeeves_data_dir()

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
            "cli_available": JEEVES_CLI_AVAILABLE,
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
            log_watcher = LogWatcher(self.state.last_run_log)

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
            
            last_state_sig = state_signature(state)
            heartbeat_interval = 15  # Send heartbeat every 15s
            last_heartbeat = time.time()
            state_poll_interval = 0.5  # 500ms state polling
            last_state_check = time.time()
            
            while True:
                # Check for new log lines (fast poll - 100ms)
                new_logs, has_logs = log_watcher.get_new_lines()
                if has_logs and new_logs:
                    self._sse_send("logs", {"lines": new_logs})
                
                # Check for state changes (slower poll - 500ms)
                now = time.time()
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


def get_jeeves_data_dir() -> Optional[Path]:
    """Get the central Jeeves data directory using XDG standard.

    Returns:
        Path to ~/.local/share/jeeves or platform equivalent.
    """
    try:
        import platformdirs
        return Path(platformdirs.user_data_dir("jeeves", appauthor=False))
    except ImportError:
        pass

    # Fallback without platformdirs
    env_dir = os.environ.get("JEEVES_DATA_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve()

    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        return Path(base) / "jeeves"
    elif hasattr(os, 'uname') and os.uname().sysname == "Darwin":
        return Path.home() / "Library" / "Application Support" / "jeeves"
    else:
        xdg_data = os.environ.get("XDG_DATA_HOME")
        if xdg_data:
            return Path(xdg_data) / "jeeves"
        return Path.home() / ".local" / "share" / "jeeves"


def list_central_issues() -> List[Dict]:
    """List all issues from the central Jeeves data directory.

    Returns:
        List of issue info dicts.
    """
    data_dir = get_jeeves_data_dir()
    if not data_dir:
        return []

    issues_dir = data_dir / "issues"
    if not issues_dir.exists():
        return []

    results = []

    for owner_dir in issues_dir.iterdir():
        if not owner_dir.is_dir():
            continue

        for repo_dir in owner_dir.iterdir():
            if not repo_dir.is_dir():
                continue

            for issue_dir in repo_dir.iterdir():
                if not issue_dir.is_dir():
                    continue

                issue_file = issue_dir / "issue.json"
                if not issue_file.exists():
                    continue

                try:
                    with open(issue_file, "r", encoding="utf-8") as f:
                        data = json.load(f)

                    issue_data = data.get("issue", {})
                    if isinstance(issue_data, int):
                        issue_number = issue_data
                        issue_title = ""
                    else:
                        issue_number = issue_data.get("number", 0)
                        issue_title = issue_data.get("title", "")

                    results.append({
                        "owner": owner_dir.name,
                        "repo": repo_dir.name,
                        "issue_number": issue_number,
                        "issue_title": issue_title,
                        "branch": data.get("branchName", ""),
                        "state_dir": str(issue_dir),
                        "status": data.get("status", {}),
                        "mtime": issue_file.stat().st_mtime,
                    })
                except (json.JSONDecodeError, OSError):
                    continue

    return sorted(results, key=lambda x: x.get("mtime", 0), reverse=True)


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

    if not JEEVES_CLI_AVAILABLE:
        print("Error: Jeeves CLI modules not available.")
        print("Make sure the jeeves package is installed or in PYTHONPATH.")
        return 1

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

    # If no issue specified, try to find the most recent one
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

    # Create a default state dir if none found
    if not state_dir:
        data_dir = get_data_dir()
        state_dir = data_dir / "viewer-default"
        state_dir.mkdir(parents=True, exist_ok=True)

    print("")
    print("  Jeeves Real-time Viewer")
    print("  " + "=" * 40)
    print(f"  CLI available: {JEEVES_CLI_AVAILABLE}")
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

    state = JeevesState(str(state_dir))
    run_manager = JeevesRunManager(issue_ref=issue_ref)
    jeeves_dir = Path(__file__).resolve().parent.parent
    prompt_manager = JeevesPromptManager(jeeves_dir)

    def handler(*args_handler, **kwargs_handler):
        return JeevesViewerHandler(
            *args_handler,
            state=state,
            run_manager=run_manager,
            prompt_manager=prompt_manager,
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
