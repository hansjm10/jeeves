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


class JeevesPromptManager:
    """Read/write Jeeves prompt templates stored alongside jeeves.sh."""

    def __init__(self, prompt_dir: Path):
        self.prompt_dir = prompt_dir.resolve()
        self._lock = Lock()

    def list_prompts(self) -> List[Dict]:
        prompts: List[Dict] = []
        try:
            for path in sorted(self.prompt_dir.glob("**/*.md")):
                if not path.is_file():
                    continue
                stat = path.stat()
                # Use relative path from prompt_dir as ID
                rel_path = path.relative_to(self.prompt_dir)
                prompts.append(
                    {
                        "id": str(rel_path),
                        "name": str(rel_path),
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
        # Disallow backslashes and parent directory traversal
        if "\\" in prompt_id or ".." in prompt_id:
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

    def __init__(self, *, state_dir: Path, jeeves_script: Path, work_dir: Optional[Path] = None):
        self.state_dir = state_dir.resolve()
        self.work_dir = (work_dir or self.state_dir.parent).resolve()
        self.jeeves_script = jeeves_script.resolve()

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
        }

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

            if not self.jeeves_script.exists():
                raise FileNotFoundError(f"jeeves.sh not found at {self.jeeves_script}")

            if runner not in {"auto", "codex", "claude", "opencode"}:
                raise ValueError("runner must be one of: auto, codex, claude, opencode")

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

            cmd: List[str] = [str(self.jeeves_script), "--max-iterations", str(max_iterations_int)]
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
        init_issue_script: Optional[Path] = None,
        **kwargs,
    ):
        self.state = state
        self.run_manager = run_manager
        self.prompt_manager = prompt_manager
        self.allow_remote_run = allow_remote_run
        self.init_issue_script = init_issue_script
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
        script = self.init_issue_script
        if not script:
            self._send_json({"ok": False, "error": "init-issue script not configured"}, status=404)
            return
        self._send_json({"ok": True, "script": {"path": str(script), "exists": script.exists()}})

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

        script = self.init_issue_script
        if not script or not script.exists():
            self._send_json({"ok": False, "error": "init-issue.sh not found"}, status=500)
            return

        body = self._read_json_body()

        issue = (body.get("issue") or "").strip()
        design_doc = (body.get("design_doc") or "").strip()
        repo = (body.get("repo") or "").strip()
        branch = (body.get("branch") or "").strip()
        force = bool(body.get("force", False))

        if not issue:
            self._send_json({"ok": False, "error": "issue is required"}, status=400)
            return

        cmd: List[str] = [str(script), "--state-dir", str(self.run_manager.state_dir), "--issue", issue]
        if design_doc:
            cmd += ["--design-doc", design_doc]
        if repo:
            cmd += ["--repo", repo]
        if branch:
            cmd += ["--branch", branch]
        if force:
            cmd += ["--force"]

        try:
            proc = subprocess.run(
                cmd,
                cwd=str(self.run_manager.work_dir),
                capture_output=True,
                text=True,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            self._send_json({"ok": False, "error": "init-issue.sh timed out"}, status=504)
            return
        except Exception as e:
            self._send_json({"ok": False, "error": f"Failed to run init-issue.sh: {e}"}, status=500)
            return

        output = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        self._send_json(
            {
                "ok": proc.returncode == 0,
                "returncode": proc.returncode,
                "command": cmd,
                "output": output.strip(),
            },
            status=200 if proc.returncode == 0 else 400,
        )
    
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


def find_state_dir() -> Optional[str]:
    """Find Jeeves state directory (or suggest a default)."""
    cwd = Path.cwd()
    fallback: Optional[str] = None
    
    # Try git root first (matches jeeves.sh behavior)
    try:
        root = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], stderr=subprocess.DEVNULL).decode().strip()
        git_state_dir = Path(root) / "jeeves"
        fallback = str(git_state_dir)
        # Verify it looks like a state dir (has logs or config) or just exists at root
        if git_state_dir.exists():
            return str(git_state_dir)
    except Exception:
        pass
    
    # Check current directory
    state_dir = cwd / "jeeves"
    if state_dir.exists() and (state_dir / "last-run.log").exists():
        return str(state_dir)
    
    # Check parent directories
    for parent in [cwd] + list(cwd.parents):
        state_dir = parent / "jeeves"
        if state_dir.exists():
            # Verify it has key files to avoid confusing with scripts/jeeves
            if (state_dir / "last-run.log").exists() or \
               (state_dir / "issue.json").exists() or \
               (state_dir / "prd.json").exists():
                return str(state_dir)
    
    # Fallback to any jeeves dir if strict check fails
    if (cwd / "jeeves").exists():
        return str(cwd / "jeeves")
        
    for parent in [cwd] + list(cwd.parents):
        state_dir = parent / "jeeves"
        if state_dir.exists():
             return str(state_dir)

    # No existing state dir found; suggest a default location so the viewer can still run.
    if fallback:
        return fallback
    return str(cwd / "jeeves")


def main():
    parser = argparse.ArgumentParser(description="Jeeves Real-time Viewer")
    parser.add_argument("--port", "-p", type=int, default=8080, help="Port to serve on")
    parser.add_argument("--state-dir", "-s", type=str, help="Path to Jeeves state directory")
    parser.add_argument(
        "--allow-remote-run",
        action="store_true",
        help="Allow run control, init, and prompt edits from non-localhost clients (unsafe on untrusted networks).",
    )
    args = parser.parse_args()

    env_allow_remote = str(os.environ.get("JEEVES_VIEWER_ALLOW_REMOTE_RUN", "")).strip().lower() in {"1", "true", "yes", "on"}
    if env_allow_remote:
        args.allow_remote_run = True
    
    state_dir = args.state_dir or find_state_dir()
    if not state_dir:
        print("Error: Could not find Jeeves state directory")
        print("Run this from your project directory or specify --state-dir")
        return 1

    try:
        Path(state_dir).mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"Error: Could not create state directory: {state_dir}")
        print(f"Reason: {e}")
        return 1
    
    print("")
    print("  Jeeves Real-time Viewer")
    print("  " + "=" * 40)
    print(f"  State directory: {state_dir}")
    print(f"  Server: http://localhost:{args.port}")
    print("")
    print("  Press Ctrl+C to stop")
    print("")
    
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    state = JeevesState(state_dir)
    jeeves_root = Path(__file__).resolve().parent.parent
    run_manager = JeevesRunManager(
        state_dir=Path(state_dir),
        jeeves_script=(jeeves_root / "bin" / "jeeves.sh"),
        work_dir=Path(state_dir).resolve().parent,
    )
    prompt_manager = JeevesPromptManager(jeeves_root / "prompts")
    init_issue_script = jeeves_root / "bin" / "init-issue.sh"
    
    def handler(*args_handler, **kwargs_handler):
        return JeevesViewerHandler(
            *args_handler,
            state=state,
            run_manager=run_manager,
            prompt_manager=prompt_manager,
            allow_remote_run=args.allow_remote_run,
            init_issue_script=init_issue_script,
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
