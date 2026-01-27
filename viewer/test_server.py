import argparse
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


class ArgumentParserTests(unittest.TestCase):
    """Tests for CLI argument parsing via --help output."""

    def test_work_dir_in_help(self):
        """Test that --work-dir and -w appear in help text."""
        result = subprocess.run(
            ["python", "-c", "import viewer.server; viewer.server.main()", "--help"],
            capture_output=True,
            text=True,
            cwd=Path(__file__).resolve().parent.parent,
        )
        # Help should exit with 0 and show the work-dir option
        self.assertEqual(result.returncode, 0, f"Help failed: {result.stderr}")
        self.assertIn("--work-dir", result.stdout, "Missing --work-dir in help")
        self.assertIn("-w", result.stdout, "Missing -w in help")


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

        # Create prompts directory structure matching new layout
        self.prompts_dir = self.tools_dir / "prompts"
        self.prompts_dir.mkdir(parents=True, exist_ok=True)
        (self.prompts_dir / "task").mkdir(parents=True, exist_ok=True)

        (self.tools_dir / "prompt.md").write_text("# Prompt\nHello\n")
        (self.prompts_dir / "design.md").write_text("# Design Prompt\n")

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
        prompt_manager = JeevesPromptManager(self.prompts_dir)

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
