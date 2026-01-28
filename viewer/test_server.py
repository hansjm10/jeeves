import json
import os
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


from viewer.server import JeevesPromptManager, JeevesRunManager, JeevesState, JeevesViewerHandler, ThreadingHTTPServer


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _request_json(conn: HTTPConnection, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Tuple[int, Any]:
    raw = b""
    headers = {}
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(raw))
    conn.request(method, path, body=raw if body is not None else None, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    try:
        parsed = json.loads(data.decode("utf-8")) if data else None
    except Exception:
        parsed = None
    return resp.status, parsed


class ViewerRunApiTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp_path = Path(self._tmp.name)

        self.repo_dir = tmp_path / "repo"
        self.repo_dir.mkdir(parents=True, exist_ok=True)

        init_proc = subprocess.run(
            ["git", "init", "-b", "main"],
            cwd=self.repo_dir,
            capture_output=True,
            text=True,
        )
        if init_proc.returncode != 0:
            subprocess.run(["git", "init"], cwd=self.repo_dir, check=True, capture_output=True, text=True)
            subprocess.run(["git", "checkout", "-b", "main"], cwd=self.repo_dir, check=True, capture_output=True, text=True)

        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.repo_dir, check=True)

        (self.repo_dir / "README.md").write_text("v1\n")
        subprocess.run(["git", "add", "README.md"], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=self.repo_dir, check=True, capture_output=True, text=True)

        self.remote_dir = tmp_path / "remote.git"
        subprocess.run(["git", "init", "--bare", str(self.remote_dir)], cwd=tmp_path, check=True, capture_output=True, text=True)
        subprocess.run(["git", "remote", "add", "origin", str(self.remote_dir)], cwd=self.repo_dir, check=True)
        subprocess.run(["git", "push", "-u", "origin", "main"], cwd=self.repo_dir, check=True, capture_output=True, text=True)
        subprocess.run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], cwd=self.remote_dir, check=True, capture_output=True, text=True)

        self.repo2_dir = tmp_path / "repo2"
        subprocess.run(["git", "clone", str(self.remote_dir), str(self.repo2_dir)], cwd=tmp_path, check=True, capture_output=True, text=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.repo2_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.repo2_dir, check=True)
        (self.repo2_dir / "README.md").write_text("v2\n")
        subprocess.run(["git", "add", "README.md"], cwd=self.repo2_dir, check=True)
        subprocess.run(["git", "commit", "-m", "update"], cwd=self.repo2_dir, check=True, capture_output=True, text=True)
        subprocess.run(["git", "push"], cwd=self.repo2_dir, check=True, capture_output=True, text=True)

        subprocess.run(["git", "checkout", "-b", "issue/test"], cwd=self.repo_dir, check=True, capture_output=True, text=True)

        self.state_dir = self.repo_dir / "jeeves"
        self.state_dir.mkdir(parents=True, exist_ok=True)

        self.tools_dir = tmp_path / "jeeves_tools"
        self.tools_dir.mkdir(parents=True, exist_ok=True)

        (self.tools_dir / "prompt.md").write_text("# Prompt\nHello\n")
        (self.tools_dir / "prompt.issue.design.md").write_text("# Design Prompt\n")

        self.init_script = self.tools_dir / "init-issue.sh"
        _write_executable(
            self.init_script,
            """#!/usr/bin/env bash
set -euo pipefail

STATE_DIR=""
ISSUE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --issue) ISSUE="$2"; shift 2 ;;
    --design-doc) shift 2 ;;
    --repo) shift 2 ;;
    --branch) shift 2 ;;
    --force) shift 1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR"
printf '{\"issue\": {\"number\": %s}}\\n' "$ISSUE" > "$STATE_DIR/issue.json"
echo \"[INFO] Wrote $STATE_DIR/issue.json\"
""",
        )

        self.dummy_script = tmp_path / "dummy_jeeves.sh"
        _write_executable(
            self.dummy_script,
            """#!/usr/bin/env bash
set -euo pipefail

echo "dummy jeeves: starting"
echo "runner=${JEEVES_RUNNER:-}"
echo "mode=${JEEVES_MODE:-}"
echo "work_dir=${JEEVES_WORK_DIR:-}"
echo "state_dir=${JEEVES_STATE_DIR:-}"

if [[ -n "${JEEVES_PROMPT_APPEND_FILE:-}" && -f "${JEEVES_PROMPT_APPEND_FILE:-}" ]]; then
  echo "prompt_append_file=${JEEVES_PROMPT_APPEND_FILE}"
  echo "prompt_append_begin"
  cat "${JEEVES_PROMPT_APPEND_FILE}"
  echo "prompt_append_end"
fi

mkdir -p "${JEEVES_STATE_DIR}"
echo "dummy log line 1" >> "${JEEVES_STATE_DIR}/last-run.log"
sleep 5
echo "dummy log line 2" >> "${JEEVES_STATE_DIR}/last-run.log"
echo "dummy jeeves: done"
""",
        )

        state = JeevesState(str(self.state_dir))
        run_manager = JeevesRunManager(state_dir=self.state_dir, jeeves_script=self.dummy_script, work_dir=self.repo_dir)
        prompt_manager = JeevesPromptManager(self.tools_dir)

        def handler(*args, **kwargs):
            return JeevesViewerHandler(
                *args,
                state=state,
                run_manager=run_manager,
                prompt_manager=prompt_manager,
                allow_remote_run=True,
                init_issue_script=self.init_script,
                **kwargs,
            )

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]

        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self._tmp.cleanup()

    def test_run_start_status_stop(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            status, data = _request_json(
                conn,
                "POST",
                "/api/run",
                {"runner": "codex", "max_iterations": 1, "output_mode": "stream"},
            )
            self.assertEqual(status, 200, data)
            self.assertTrue(data["ok"])
            self.assertTrue(data["run"]["running"])
            self.assertIsNotNone(data["run"]["pid"])

            self.assertIsNone(data["run"]["prompt_append_file"])

            status, data = _request_json(conn, "GET", "/api/run")
            self.assertEqual(status, 200)
            self.assertTrue(data["run"]["running"])

            # Second start should conflict.
            status, data = _request_json(conn, "POST", "/api/run", {"runner": "codex", "max_iterations": 1})
            self.assertEqual(status, 409)
            self.assertFalse(data["ok"])

            # Logs endpoint should show the dummy header quickly.
            deadline = time.time() + 2.0
            logs = []
            while time.time() < deadline:
                status, data = _request_json(conn, "GET", "/api/run/logs")
                self.assertEqual(status, 200)
                logs = data.get("logs", []) if isinstance(data, dict) else []
                if any("dummy jeeves: starting" in line for line in logs):
                    break
                time.sleep(0.05)
            self.assertTrue(any("dummy jeeves: starting" in line for line in logs))

            status, data = _request_json(conn, "POST", "/api/run/stop", {})
            self.assertEqual(status, 200)
            self.assertTrue(data["ok"])

            # Eventually not running.
            deadline = time.time() + 5.0
            while time.time() < deadline:
                status, data = _request_json(conn, "GET", "/api/run")
                self.assertEqual(status, 200)
                if not data["run"]["running"]:
                    break
                time.sleep(0.05)
            self.assertFalse(data["run"]["running"])
            self.assertIsNotNone(data["run"]["returncode"])
        finally:
            conn.close()

    def test_prompt_api_read_write(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            status, data = _request_json(conn, "GET", "/api/prompts")
            self.assertEqual(status, 200, data)
            self.assertTrue(data["ok"])
            self.assertTrue(any(p.get("id") == "prompt.md" for p in data.get("prompts", [])))

            status, data = _request_json(conn, "GET", "/api/prompts/prompt.md")
            self.assertEqual(status, 200, data)
            self.assertTrue(data["ok"])
            self.assertIn("Hello", data["prompt"]["content"])

            status, data = _request_json(conn, "POST", "/api/prompts/prompt.md", {"content": "# Updated\n"})
            self.assertEqual(status, 200, data)
            self.assertTrue(data["ok"])

            status, data = _request_json(conn, "GET", "/api/prompts/prompt.md")
            self.assertEqual(status, 200, data)
            self.assertIn("# Updated", data["prompt"]["content"])
        finally:
            conn.close()

    def test_init_issue(self):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            status, data = _request_json(conn, "POST", "/api/init/issue", {"issue": "123"})
            self.assertEqual(status, 200, data)
            self.assertTrue(data["ok"], data)

            issue_json = self.state_dir / "issue.json"
            self.assertTrue(issue_json.exists())
            payload = json.loads(issue_json.read_text())
            self.assertEqual(payload.get("issue", {}).get("number"), 123)
        finally:
            conn.close()

    def test_issue_status_update(self):
        issue_json = self.state_dir / "issue.json"
        issue_json.write_text(
            json.dumps(
                {
                    "project": "Jeeves Test Project",
                    "branchName": "issue/1-test-branch",
                    "issue": {"number": 1, "repo": "example/repo"},
                    "designDocPath": "docs/design-document-template.md",
                    "status": {
                        "implemented": True,
                        "prCreated": True,
                        "prDescriptionReady": True,
                        "reviewClean": True,
                        "ciClean": False,
                        "coverageClean": False,
                        "coverageNeedsFix": True,
                        "sonarClean": False,
                    },
                    "pullRequest": {"number": 1, "url": "https://example.com/pr/1"},
                },
                indent=2,
            )
            + "\n"
        )

        coverage_failures = self.state_dir / "coverage-failures.md"
        coverage_failures.write_text("Failing test: should do something\n")
        self.assertTrue(coverage_failures.exists())

        conn = HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            status, data = _request_json(
                conn,
                "POST",
                "/api/issue/status",
                {"updates": {"coverageClean": True, "ciClean": True}},
            )
            self.assertEqual(status, 200, data)
            self.assertTrue(data["ok"], data)

            payload = json.loads(issue_json.read_text())
            status_obj = payload.get("status", {})
            self.assertTrue(status_obj.get("coverageClean"))
            self.assertFalse(status_obj.get("coverageNeedsFix"))
            self.assertTrue(status_obj.get("ciClean"))

            # coverage-failures.md should be cleared so coverage toggles are effective.
            if coverage_failures.exists():
                self.assertEqual(coverage_failures.read_text(), "")
        finally:
            conn.close()

    def test_git_update_main(self):
        proc_branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=self.repo_dir,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc_branch.stdout.strip(), "issue/test")

        self.assertEqual((self.repo_dir / "README.md").read_text(), "v1\n")

        conn = HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            status, data = _request_json(conn, "POST", "/api/git/update-main", {"branch": "main"})
            self.assertEqual(status, 200, data)
            self.assertTrue(data["ok"], data)

            proc_branch = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=self.repo_dir,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc_branch.stdout.strip(), "main")
            self.assertEqual((self.repo_dir / "README.md").read_text(), "v2\n")
        finally:
            conn.close()


class SDKOutputWatcherTests(unittest.TestCase):
    """Test SDKOutputWatcher class for incremental SDK output tracking."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.sdk_output_file = self.tmp_path / "sdk-output.json"

    def tearDown(self):
        self._tmp.cleanup()

    def _write_sdk_output(self, data: Dict[str, Any]) -> None:
        """Helper to write SDK output JSON."""
        self.sdk_output_file.write_text(json.dumps(data))

    def test_handles_file_not_found_gracefully(self):
        """SDKOutputWatcher handles missing file without error."""
        from viewer.server import SDKOutputWatcher

        watcher = SDKOutputWatcher(self.sdk_output_file)
        new_messages, new_tool_calls, has_changes = watcher.get_updates()

        self.assertEqual(new_messages, [])
        self.assertEqual(new_tool_calls, [])
        self.assertFalse(has_changes)

    def test_returns_initial_messages_on_first_read(self):
        """SDKOutputWatcher returns all messages on first read."""
        from viewer.server import SDKOutputWatcher

        initial_data = {
            "schema": "jeeves.sdk.v1",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there!"},
            ],
            "tool_calls": [
                {"name": "Read", "tool_use_id": "1", "duration_ms": 100}
            ],
            "stats": {"message_count": 2, "tool_call_count": 1}
        }
        self._write_sdk_output(initial_data)

        watcher = SDKOutputWatcher(self.sdk_output_file)
        new_messages, new_tool_calls, has_changes = watcher.get_updates()

        self.assertEqual(len(new_messages), 2)
        self.assertEqual(len(new_tool_calls), 1)
        self.assertTrue(has_changes)

    def test_returns_only_new_messages_on_subsequent_reads(self):
        """SDKOutputWatcher returns only new messages since last check."""
        from viewer.server import SDKOutputWatcher

        initial_data = {
            "schema": "jeeves.sdk.v1",
            "messages": [
                {"role": "user", "content": "Hello"},
            ],
            "tool_calls": [],
            "stats": {"message_count": 1, "tool_call_count": 0}
        }
        self._write_sdk_output(initial_data)

        watcher = SDKOutputWatcher(self.sdk_output_file)
        # First read
        watcher.get_updates()

        # Add more messages
        updated_data = {
            "schema": "jeeves.sdk.v1",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi!"},
                {"role": "user", "content": "What's up?"},
            ],
            "tool_calls": [
                {"name": "Read", "tool_use_id": "1", "duration_ms": 100}
            ],
            "stats": {"message_count": 3, "tool_call_count": 1}
        }
        self._write_sdk_output(updated_data)

        # Second read should only return new messages
        new_messages, new_tool_calls, has_changes = watcher.get_updates()

        self.assertEqual(len(new_messages), 2)
        self.assertEqual(new_messages[0]["content"], "Hi!")
        self.assertEqual(new_messages[1]["content"], "What's up?")
        self.assertEqual(len(new_tool_calls), 1)
        self.assertTrue(has_changes)

    def test_no_changes_when_file_unchanged(self):
        """SDKOutputWatcher reports no changes when file is unchanged."""
        from viewer.server import SDKOutputWatcher

        data = {
            "schema": "jeeves.sdk.v1",
            "messages": [{"role": "user", "content": "Hello"}],
            "tool_calls": [],
            "stats": {"message_count": 1, "tool_call_count": 0}
        }
        self._write_sdk_output(data)

        watcher = SDKOutputWatcher(self.sdk_output_file)
        # First read
        watcher.get_updates()

        # Second read without file change
        new_messages, new_tool_calls, has_changes = watcher.get_updates()

        self.assertEqual(new_messages, [])
        self.assertEqual(new_tool_calls, [])
        self.assertFalse(has_changes)

    def test_thread_safe_with_lock(self):
        """SDKOutputWatcher is thread-safe with Lock."""
        from viewer.server import SDKOutputWatcher

        data = {
            "schema": "jeeves.sdk.v1",
            "messages": [{"role": "user", "content": "Hello"}],
            "tool_calls": [],
            "stats": {"message_count": 1, "tool_call_count": 0}
        }
        self._write_sdk_output(data)

        watcher = SDKOutputWatcher(self.sdk_output_file)
        # Check that watcher has a _lock attribute
        self.assertTrue(hasattr(watcher, '_lock'))

        # Run concurrent reads
        results = []
        def read_updates():
            msgs, tools, changed = watcher.get_updates()
            results.append((len(msgs), len(tools), changed))

        threads = [threading.Thread(target=read_updates) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # All threads should complete without error
        self.assertEqual(len(results), 5)

    def test_handles_malformed_json_gracefully(self):
        """SDKOutputWatcher handles malformed JSON without crashing."""
        from viewer.server import SDKOutputWatcher

        self.sdk_output_file.write_text("{invalid json")

        watcher = SDKOutputWatcher(self.sdk_output_file)
        new_messages, new_tool_calls, has_changes = watcher.get_updates()

        self.assertEqual(new_messages, [])
        self.assertEqual(new_tool_calls, [])
        self.assertFalse(has_changes)

    def test_reset_clears_tracking_state(self):
        """SDKOutputWatcher.reset() clears message/tool tracking state."""
        from viewer.server import SDKOutputWatcher

        data = {
            "schema": "jeeves.sdk.v1",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi!"},
            ],
            "tool_calls": [{"name": "Read", "tool_use_id": "1"}],
            "stats": {"message_count": 2, "tool_call_count": 1}
        }
        self._write_sdk_output(data)

        watcher = SDKOutputWatcher(self.sdk_output_file)
        # First read
        watcher.get_updates()

        # Reset
        watcher.reset()

        # Should return all messages again after reset
        new_messages, new_tool_calls, has_changes = watcher.get_updates()
        self.assertEqual(len(new_messages), 2)
        self.assertEqual(len(new_tool_calls), 1)
        self.assertTrue(has_changes)

    def test_handles_missing_fields_gracefully(self):
        """SDKOutputWatcher handles SDK output with missing fields."""
        from viewer.server import SDKOutputWatcher

        # SDK output without messages or tool_calls
        data = {
            "schema": "jeeves.sdk.v1",
            "stats": {}
        }
        self._write_sdk_output(data)

        watcher = SDKOutputWatcher(self.sdk_output_file)
        new_messages, new_tool_calls, has_changes = watcher.get_updates()

        self.assertEqual(new_messages, [])
        self.assertEqual(new_tool_calls, [])
        # File exists and was read, but no content - still counts as initial read
        self.assertFalse(has_changes)


class SDKSSEEventTests(unittest.TestCase):
    """Test SDK SSE event streaming in _handle_sse()."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)
        self.state_dir = self.tmp_path / "jeeves"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.sdk_output_file = self.state_dir / "sdk-output.json"

    def tearDown(self):
        self._tmp.cleanup()

    def _write_sdk_output(self, data: Dict[str, Any]) -> None:
        """Helper to write SDK output JSON."""
        self.sdk_output_file.write_text(json.dumps(data))

    def _parse_sse_events(self, raw_data: bytes, max_events: int = 10) -> list:
        """Parse SSE events from raw response data."""
        events = []
        lines = raw_data.decode("utf-8", errors="replace").split("\n")
        current_event = None
        for line in lines:
            line = line.strip()
            if line.startswith("event:"):
                current_event = line.split(": ", 1)[1] if ": " in line else line[6:]
            elif line.startswith("data:") and current_event:
                data_str = line.split(": ", 1)[1] if ": " in line else line[5:]
                try:
                    data = json.loads(data_str)
                    events.append({"event": current_event, "data": data})
                except json.JSONDecodeError:
                    pass
                current_event = None
            elif line == "":
                current_event = None
            if len(events) >= max_events:
                break
        return events

    def _read_sse_with_timeout(self, conn, timeout_secs: float = 2.0, max_events: int = 10) -> list:
        """Read SSE events from connection with timeout."""
        import socket
        conn.sock.settimeout(0.1)  # Short timeout for each read
        events = []
        buffer = b""
        deadline = time.time() + timeout_secs

        while time.time() < deadline:
            try:
                chunk = conn.sock.recv(4096)
                if not chunk:
                    break
                buffer += chunk
                # Try to parse events from buffer
                events = self._parse_sse_events(buffer, max_events)
                if len(events) >= max_events:
                    break
            except socket.timeout:
                # Expected - just continue
                events = self._parse_sse_events(buffer, max_events)
                if len(events) >= max_events:
                    break
            except Exception:
                break

        return events

    def test_sdk_init_event_sent_on_session_start(self):
        """SSE stream sends sdk-init event when SDK session is detected."""
        from viewer.server import JeevesState, JeevesRunManager, JeevesPromptManager, JeevesViewerHandler, ThreadingHTTPServer

        # Create SDK output with session info
        sdk_data = {
            "schema": "jeeves.sdk.v1",
            "session_id": "test-session-123",
            "started_at": "2026-01-28T10:00:00Z",
            "messages": [],
            "tool_calls": [],
            "stats": {"message_count": 0, "tool_call_count": 0}
        }
        self._write_sdk_output(sdk_data)

        state = JeevesState(str(self.state_dir))
        run_manager = JeevesRunManager(state_dir=self.state_dir)
        prompt_manager = JeevesPromptManager(self.tmp_path)

        def handler(*args, **kwargs):
            return JeevesViewerHandler(
                *args, state=state, run_manager=run_manager, prompt_manager=prompt_manager,
                allow_remote_run=True, **kwargs
            )

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = httpd.server_address[1]
        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()

        try:
            import socket
            conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn.connect(("127.0.0.1", port))
            conn.sendall(b"GET /api/stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
            conn.settimeout(0.1)

            buffer = b""
            deadline = time.time() + 3.0
            while time.time() < deadline:
                try:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    events = self._parse_sse_events(buffer, 5)
                    if len(events) >= 3:
                        break
                except socket.timeout:
                    events = self._parse_sse_events(buffer, 5)
                    if len(events) >= 3:
                        break
            else:
                events = self._parse_sse_events(buffer, 5)

            conn.close()

            # Check that sdk-init event was sent
            sdk_init_events = [e for e in events if e["event"] == "sdk-init"]
            self.assertGreaterEqual(len(sdk_init_events), 1, f"Expected sdk-init event, got: {[e['event'] for e in events]}")
            self.assertEqual(sdk_init_events[0]["data"]["session_id"], "test-session-123")
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_sdk_message_event_sent_for_new_messages(self):
        """SSE stream sends sdk-message event for new messages."""
        from viewer.server import JeevesState, JeevesRunManager, JeevesPromptManager, JeevesViewerHandler, ThreadingHTTPServer

        # Start with one message
        sdk_data = {
            "schema": "jeeves.sdk.v1",
            "session_id": "test-session-456",
            "messages": [{"role": "user", "content": "Hello"}],
            "tool_calls": [],
            "stats": {"message_count": 1, "tool_call_count": 0}
        }
        self._write_sdk_output(sdk_data)

        state = JeevesState(str(self.state_dir))
        run_manager = JeevesRunManager(state_dir=self.state_dir)
        prompt_manager = JeevesPromptManager(self.tmp_path)

        def handler(*args, **kwargs):
            return JeevesViewerHandler(
                *args, state=state, run_manager=run_manager, prompt_manager=prompt_manager,
                allow_remote_run=True, **kwargs
            )

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = httpd.server_address[1]
        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()

        try:
            import socket
            conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn.connect(("127.0.0.1", port))
            conn.sendall(b"GET /api/stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
            conn.settimeout(0.1)

            buffer = b""
            deadline = time.time() + 3.0
            while time.time() < deadline:
                try:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    events = self._parse_sse_events(buffer, 10)
                    if len(events) >= 5:
                        break
                except socket.timeout:
                    events = self._parse_sse_events(buffer, 10)
                    if len(events) >= 5:
                        break
            else:
                events = self._parse_sse_events(buffer, 10)

            conn.close()

            # Check for sdk-message events (initial messages should be sent as sdk-message)
            sdk_message_events = [e for e in events if e["event"] == "sdk-message"]
            self.assertGreaterEqual(len(sdk_message_events), 1, f"Expected sdk-message event, got: {[e['event'] for e in events]}")
            # First message should be "Hello"
            self.assertEqual(sdk_message_events[0]["data"]["message"]["content"], "Hello")
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_sdk_tool_events_sent_for_tool_calls(self):
        """SSE stream sends sdk-tool-start and sdk-tool-complete events for tool calls."""
        from viewer.server import JeevesState, JeevesRunManager, JeevesPromptManager, JeevesViewerHandler, ThreadingHTTPServer

        sdk_data = {
            "schema": "jeeves.sdk.v1",
            "session_id": "test-session-789",
            "messages": [],
            "tool_calls": [
                {
                    "name": "Read",
                    "tool_use_id": "tool-1",
                    "input": {"file_path": "/test/file.py"},
                    "duration_ms": 150,
                    "is_error": False
                }
            ],
            "stats": {"message_count": 0, "tool_call_count": 1}
        }
        self._write_sdk_output(sdk_data)

        state = JeevesState(str(self.state_dir))
        run_manager = JeevesRunManager(state_dir=self.state_dir)
        prompt_manager = JeevesPromptManager(self.tmp_path)

        def handler(*args, **kwargs):
            return JeevesViewerHandler(
                *args, state=state, run_manager=run_manager, prompt_manager=prompt_manager,
                allow_remote_run=True, **kwargs
            )

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = httpd.server_address[1]
        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()

        try:
            import socket
            conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn.connect(("127.0.0.1", port))
            conn.sendall(b"GET /api/stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
            conn.settimeout(0.1)

            buffer = b""
            deadline = time.time() + 3.0
            while time.time() < deadline:
                try:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    events = self._parse_sse_events(buffer, 10)
                    if len(events) >= 5:
                        break
                except socket.timeout:
                    events = self._parse_sse_events(buffer, 10)
                    if len(events) >= 5:
                        break
            else:
                events = self._parse_sse_events(buffer, 10)

            conn.close()

            # Check for sdk-tool-start event - must be sent when tool invocation begins
            sdk_tool_start_events = [e for e in events if e["event"] == "sdk-tool-start"]
            self.assertGreaterEqual(len(sdk_tool_start_events), 1, f"Expected sdk-tool-start event, got: {[e['event'] for e in events]}")
            self.assertEqual(sdk_tool_start_events[0]["data"]["tool_use_id"], "tool-1")
            self.assertEqual(sdk_tool_start_events[0]["data"]["name"], "Read")
            self.assertEqual(sdk_tool_start_events[0]["data"]["input"], {"file_path": "/test/file.py"})

            # Check for sdk-tool-complete event - must be sent when tool returns
            sdk_tool_complete_events = [e for e in events if e["event"] == "sdk-tool-complete"]
            self.assertGreaterEqual(len(sdk_tool_complete_events), 1, f"Expected sdk-tool-complete event, got: {[e['event'] for e in events]}")
            self.assertEqual(sdk_tool_complete_events[0]["data"]["tool_use_id"], "tool-1")
            self.assertEqual(sdk_tool_complete_events[0]["data"]["name"], "Read")
            self.assertEqual(sdk_tool_complete_events[0]["data"]["duration_ms"], 150)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_sdk_complete_event_sent_when_session_ends(self):
        """SSE stream sends sdk-complete event when session is marked complete."""
        from viewer.server import JeevesState, JeevesRunManager, JeevesPromptManager, JeevesViewerHandler, ThreadingHTTPServer

        sdk_data = {
            "schema": "jeeves.sdk.v1",
            "session_id": "test-session-complete",
            "started_at": "2026-01-28T10:00:00Z",
            "ended_at": "2026-01-28T10:05:00Z",
            "success": True,
            "messages": [{"role": "user", "content": "Done"}],
            "tool_calls": [],
            "stats": {"message_count": 1, "tool_call_count": 0, "duration_seconds": 300}
        }
        self._write_sdk_output(sdk_data)

        state = JeevesState(str(self.state_dir))
        run_manager = JeevesRunManager(state_dir=self.state_dir)
        prompt_manager = JeevesPromptManager(self.tmp_path)

        def handler(*args, **kwargs):
            return JeevesViewerHandler(
                *args, state=state, run_manager=run_manager, prompt_manager=prompt_manager,
                allow_remote_run=True, **kwargs
            )

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        port = httpd.server_address[1]
        server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        server_thread.start()

        try:
            import socket
            conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn.connect(("127.0.0.1", port))
            conn.sendall(b"GET /api/stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
            conn.settimeout(0.1)

            buffer = b""
            deadline = time.time() + 3.0
            while time.time() < deadline:
                try:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    events = self._parse_sse_events(buffer, 10)
                    if len(events) >= 5:
                        break
                except socket.timeout:
                    events = self._parse_sse_events(buffer, 10)
                    if len(events) >= 5:
                        break
            else:
                events = self._parse_sse_events(buffer, 10)

            conn.close()

            # Check for sdk-complete event
            sdk_complete_events = [e for e in events if e["event"] == "sdk-complete"]
            self.assertGreaterEqual(len(sdk_complete_events), 1, f"Expected sdk-complete event, got: {[e['event'] for e in events]}")
            self.assertEqual(sdk_complete_events[0]["data"]["status"], "success")
            self.assertIn("summary", sdk_complete_events[0]["data"])
        finally:
            httpd.shutdown()
            httpd.server_close()


class SDKDefaultTabTests(unittest.TestCase):
    """Test that SDK tab is the default for new sessions (T4)."""

    def test_frontend_default_tab_is_sdk(self):
        """Frontend index.html initializes mainTab to 'sdk' by default."""
        # Read the frontend HTML
        viewer_dir = Path(__file__).parent
        index_html = viewer_dir / "index.html"
        self.assertTrue(index_html.exists(), "index.html should exist")

        content = index_html.read_text()

        # Check that the initial mainTab variable is set to 'sdk'
        self.assertIn("let mainTab = 'sdk';", content,
            "mainTab should be initialized to 'sdk' by default")

    def test_frontend_fallback_tab_is_sdk(self):
        """Frontend falls back to 'sdk' when localStorage has no saved tab."""
        viewer_dir = Path(__file__).parent
        index_html = viewer_dir / "index.html"
        content = index_html.read_text()

        # Check that the fallback in setMainTab call is 'sdk'
        self.assertIn("setMainTab(savedTab || 'sdk')", content,
            "Should fall back to 'sdk' when no saved tab in localStorage")

    def test_frontend_error_fallback_tab_is_sdk(self):
        """Frontend falls back to 'sdk' when localStorage throws error."""
        viewer_dir = Path(__file__).parent
        index_html = viewer_dir / "index.html"
        content = index_html.read_text()

        # Check that the catch block falls back to 'sdk'
        # The pattern is: } catch (e) {\n            setMainTab('sdk');
        self.assertRegex(content, r"catch\s*\(e\)\s*\{\s*\n\s*setMainTab\('sdk'\)",
            "Should fall back to 'sdk' in catch block when localStorage fails")

    def test_frontend_preserves_localstorage_key(self):
        """Frontend still uses 'jeeves_viewer_main_tab' localStorage key."""
        viewer_dir = Path(__file__).parent
        index_html = viewer_dir / "index.html"
        content = index_html.read_text()

        # Check that localStorage key is preserved for user preferences
        self.assertIn("localStorage.getItem('jeeves_viewer_main_tab')", content,
            "Should read from 'jeeves_viewer_main_tab' localStorage key")
        self.assertIn("localStorage.setItem('jeeves_viewer_main_tab'", content,
            "Should save to 'jeeves_viewer_main_tab' localStorage key")

    def test_frontend_logs_tab_still_accessible(self):
        """Frontend still allows switching to logs tab via click."""
        viewer_dir = Path(__file__).parent
        index_html = viewer_dir / "index.html"
        content = index_html.read_text()

        # Check that logs tab click handler exists
        self.assertIn("tabLogs.addEventListener('click', () => setMainTab('logs'))", content,
            "Logs tab should have click handler to setMainTab('logs')")


class OutputSchemaV2Tests(unittest.TestCase):
    """Test jeeves.output.v2 JSON Schema design (Task T5)."""

    def setUp(self):
        # Path to the v2 schema file
        self.schema_path = Path(__file__).parent.parent / "docs" / "output-schema-v2.json"

    def test_schema_file_exists(self):
        """docs/output-schema-v2.json should exist."""
        self.assertTrue(self.schema_path.exists(),
            f"Schema file should exist at {self.schema_path}")

    def test_schema_is_valid_json(self):
        """Schema file should be valid JSON."""
        content = self.schema_path.read_text()
        schema = json.loads(content)  # Should not raise
        self.assertIsInstance(schema, dict)

    def test_schema_has_json_schema_meta(self):
        """Schema should have $schema meta property for JSON Schema."""
        content = self.schema_path.read_text()
        schema = json.loads(content)
        self.assertIn("$schema", schema)
        self.assertIn("json-schema.org", schema["$schema"])

    def test_schema_version_is_v2(self):
        """Schema should define schema property as 'jeeves.output.v2'."""
        content = self.schema_path.read_text()
        schema = json.loads(content)
        # Check that the schema property is defined with v2 value
        props = schema.get("properties", {})
        self.assertIn("schema", props)
        schema_prop = props["schema"]
        # Should be a const with v2 or enum containing v2
        if "const" in schema_prop:
            self.assertEqual(schema_prop["const"], "jeeves.output.v2")
        elif "enum" in schema_prop:
            self.assertIn("jeeves.output.v2", schema_prop["enum"])

    def test_schema_includes_provider_info(self):
        """Schema should include provider info (name, version, metadata)."""
        content = self.schema_path.read_text()
        schema = json.loads(content)
        props = schema.get("properties", {})

        self.assertIn("provider", props, "Schema should have 'provider' property")
        provider_props = props["provider"].get("properties", {})

        self.assertIn("name", provider_props, "Provider should have 'name'")
        self.assertIn("version", provider_props, "Provider should have 'version'")
        self.assertIn("metadata", provider_props, "Provider should have 'metadata'")

    def test_schema_includes_session_with_status_enum(self):
        """Schema should include session info with status enum."""
        content = self.schema_path.read_text()
        schema = json.loads(content)
        props = schema.get("properties", {})

        self.assertIn("session", props, "Schema should have 'session' property")
        session_props = props["session"].get("properties", {})

        self.assertIn("id", session_props, "Session should have 'id'")
        self.assertIn("started_at", session_props, "Session should have 'started_at'")
        self.assertIn("ended_at", session_props, "Session should have 'ended_at'")
        self.assertIn("status", session_props, "Session should have 'status'")

        # Status should be an enum with running, success, error, cancelled
        status_prop = session_props["status"]
        self.assertIn("enum", status_prop, "Status should be an enum")
        expected_statuses = ["running", "success", "error", "cancelled"]
        for status in expected_statuses:
            self.assertIn(status, status_prop["enum"],
                f"Status enum should include '{status}'")

    def test_schema_includes_token_tracking(self):
        """Schema should include token usage tracking."""
        content = self.schema_path.read_text()
        schema = json.loads(content)
        props = schema.get("properties", {})

        # Token tracking should be in summary
        self.assertIn("summary", props, "Schema should have 'summary' property")
        summary_props = props["summary"].get("properties", {})

        self.assertIn("tokens", summary_props, "Summary should have 'tokens'")
        token_props = summary_props["tokens"].get("properties", {})

        self.assertIn("input", token_props, "Tokens should track 'input'")
        self.assertIn("output", token_props, "Tokens should track 'output'")

    def test_schema_backward_compatible_with_v1_messages(self):
        """Schema should be backward compatible with v1 messages format."""
        content = self.schema_path.read_text()
        schema = json.loads(content)

        # Check for $defs or definitions section
        defs = schema.get("$defs", schema.get("definitions", {}))

        # Should have Message definition compatible with v1
        self.assertIn("Message", defs, "Schema should define Message type")
        message_def = defs["Message"]
        message_props = message_def.get("properties", {})

        # v1 required message fields
        self.assertIn("type", message_props, "Message should have 'type'")
        self.assertIn("timestamp", message_props, "Message should have 'timestamp'")

        # v1 optional message fields
        self.assertIn("content", message_props, "Message should have 'content'")

        # Check Message type enum matches v1
        type_prop = message_props.get("type", {})
        if "enum" in type_prop:
            v1_types = ["system", "user", "assistant", "tool_result", "result"]
            for msg_type in v1_types:
                self.assertIn(msg_type, type_prop["enum"],
                    f"Message type enum should include v1 type '{msg_type}'")

    def test_schema_has_conversation_array(self):
        """Schema should have conversation array for messages."""
        content = self.schema_path.read_text()
        schema = json.loads(content)
        props = schema.get("properties", {})

        self.assertIn("conversation", props, "Schema should have 'conversation' property")
        conv_prop = props["conversation"]
        self.assertEqual(conv_prop.get("type"), "array", "Conversation should be an array")

    def test_sample_v2_document_validates(self):
        """A sample v2 document should match the schema structure."""
        content = self.schema_path.read_text()
        schema = json.loads(content)

        # Create a sample v2 document
        sample_v2 = {
            "schema": "jeeves.output.v2",
            "provider": {
                "name": "claude-sdk",
                "version": "1.0.0",
                "metadata": {}
            },
            "session": {
                "id": "test-session-123",
                "started_at": "2026-01-28T10:00:00Z",
                "ended_at": "2026-01-28T10:05:00Z",
                "status": "success"
            },
            "conversation": [
                {
                    "type": "user",
                    "content": "Hello",
                    "timestamp": "2026-01-28T10:00:01Z"
                },
                {
                    "type": "assistant",
                    "content": "Hi there!",
                    "timestamp": "2026-01-28T10:00:02Z"
                }
            ],
            "summary": {
                "message_count": 2,
                "tool_call_count": 0,
                "duration_seconds": 300,
                "tokens": {
                    "input": 100,
                    "output": 50
                },
                "errors": []
            },
            "raw": {}
        }

        # Basic structural validation (without jsonschema library)
        props = schema.get("properties", {})
        for key in sample_v2.keys():
            self.assertIn(key, props, f"Sample key '{key}' should be in schema properties")
