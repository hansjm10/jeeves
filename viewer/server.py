#!/usr/bin/env python3
"""
Ralph Real-time Viewer - A beautiful web dashboard for monitoring Ralph agent runs

Features:
- Real-time log streaming via SSE with file watching
- Proper state tracking from issue.json/prd.json
- Responsive design inspired by GitHub's UI
"""

import argparse
import json
import os
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


class RalphState:
    """Track Ralph's current state from files"""
    
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
        """Get current Ralph state"""
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
            
            state["status"] = {
                "phase": self._determine_phase(config, status),
                "implemented": status.get("implemented", False),
                "pr_created": status.get("prCreated", False) or bool(pr.get("number")),
                "pr_description_ready": status.get("prDescriptionReady", False),
                "pr_number": pr.get("number"),
                "pr_url": pr.get("url"),
                "review_clean": status.get("reviewClean", False),
                "coverage_clean": status.get("coverageClean", False),
                "coverage_needs_fix": status.get("coverageNeedsFix", False),
                "sonar_clean": status.get("sonarClean", False),
                "has_coverage_failures": self.coverage_failures.exists() and self.coverage_failures.stat().st_size > 0,
                "has_open_questions": self.open_questions.exists() and self.open_questions.stat().st_size > 0,
                "issue_number": issue.get("number") or config.get("issueNumber"),
                "issue_url": issue.get("url"),
                "issue_title": issue.get("title", ""),
                "branch_name": config.get("branchName"),
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
            # Look for "Ralph Iteration X of Y" pattern
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
        coverage_clean = status.get("coverageClean", False)
        coverage_needs_fix = status.get("coverageNeedsFix", False)
        sonar_clean = status.get("sonarClean", False)

        # Check if design doc exists on disk (matches ralph.sh behavior)
        design_doc = config.get("designDocPath") or config.get("designDoc")
        has_design_doc = False
        if design_doc:
            design_doc_path = Path(design_doc)
            if not design_doc_path.is_absolute():
                design_doc_path = self.state_dir.parent / design_doc
            has_design_doc = design_doc_path.exists()

        if not has_design_doc:
            return "design"
        if not (implemented and pr_created and pr_desc_ready):
            return "implement"
        if not review_clean:
            return "review"
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


class RalphViewerHandler(SimpleHTTPRequestHandler):
    """HTTP handler for Ralph viewer"""

    protocol_version = "HTTP/1.1"
    
    def __init__(self, *args, state: RalphState, **kwargs):
        self.state = state
        super().__init__(*args, **kwargs)
    
    def do_GET(self):
        """Handle GET requests"""
        parsed = urlparse(self.path)
        path = parsed.path
        
        if path == "/":
            path = "/index.html"
        
        if path == "/api/state":
            self._send_json(self.state.get_state())
        elif path == "/api/stream":
            self._handle_sse()
        elif path == "/api/logs":
            self._send_json({"logs": self.state.get_recent_logs(1000)})
        else:
            super().do_GET()
    
    def _send_json(self, data: Dict):
        """Send JSON response"""
        body = json.dumps(data).encode()
        self.send_response(200)
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
    """Find Ralph state directory"""
    cwd = Path.cwd()
    
    # Try git root first (matches ralph.sh behavior)
    try:
        root = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], stderr=subprocess.DEVNULL).decode().strip()
        git_state_dir = Path(root) / "ralph"
        # Verify it looks like a state dir (has logs or config) or just exists at root
        if git_state_dir.exists():
            return str(git_state_dir)
    except Exception:
        pass
    
    # Check current directory
    state_dir = cwd / "ralph"
    if state_dir.exists() and (state_dir / "last-run.log").exists():
        return str(state_dir)
    
    # Check parent directories
    for parent in [cwd] + list(cwd.parents):
        state_dir = parent / "ralph"
        if state_dir.exists():
            # Verify it has key files to avoid confusing with scripts/ralph
            if (state_dir / "last-run.log").exists() or \
               (state_dir / "issue.json").exists() or \
               (state_dir / "prd.json").exists():
                return str(state_dir)
    
    # Fallback to any ralph dir if strict check fails
    if (cwd / "ralph").exists():
        return str(cwd / "ralph")
        
    for parent in [cwd] + list(cwd.parents):
        state_dir = parent / "ralph"
        if state_dir.exists():
             return str(state_dir)

    return None


def main():
    parser = argparse.ArgumentParser(description="Ralph Real-time Viewer")
    parser.add_argument("--port", "-p", type=int, default=8080, help="Port to serve on")
    parser.add_argument("--state-dir", "-s", type=str, help="Path to Ralph state directory")
    args = parser.parse_args()
    
    state_dir = args.state_dir or find_state_dir()
    if not state_dir:
        print("Error: Could not find Ralph state directory")
        print("Run this from your project directory or specify --state-dir")
        return 1
    
    print("")
    print("  Ralph Real-time Viewer")
    print("  " + "=" * 40)
    print(f"  State directory: {state_dir}")
    print(f"  Server: http://localhost:{args.port}")
    print("")
    print("  Press Ctrl+C to stop")
    print("")
    
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    state = RalphState(state_dir)
    
    def handler(*args_handler, **kwargs_handler):
        return RalphViewerHandler(*args_handler, state=state, **kwargs_handler)
    
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
