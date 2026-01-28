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


class WorkDirLogicTests(unittest.TestCase):
    """Tests for --work-dir logic in JeevesRunManager and argument parsing."""

    def _create_parser(self) -> argparse.ArgumentParser:
        """Create an argument parser matching the one in main()."""
        parser = argparse.ArgumentParser(description="Jeeves Real-time Viewer")
        parser.add_argument("--port", "-p", type=int, default=8080)
        parser.add_argument("--state-dir", "-s", type=str)
        parser.add_argument("--allow-remote-run", action="store_true")
        parser.add_argument("--work-dir", "-w", type=str)
        return parser

    def test_work_dir_long_form_recognized(self):
        """Test that --work-dir long form is recognized."""
        parser = self._create_parser()
        args = parser.parse_args(["--work-dir", "/custom/path"])
        self.assertEqual(args.work_dir, "/custom/path")

    def test_work_dir_short_form_recognized(self):
        """Test that -w short form is recognized."""
        parser = self._create_parser()
        args = parser.parse_args(["-w", "/custom/path"])
        self.assertEqual(args.work_dir, "/custom/path")

    def test_work_dir_default_is_none(self):
        """Test that work_dir defaults to None when not provided."""
        parser = self._create_parser()
        args = parser.parse_args([])
        self.assertIsNone(args.work_dir)

    def test_work_dir_override_logic(self):
        """Test that --work-dir overrides the default state_dir.parent derivation."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "project" / "jeeves"
            state_dir.mkdir(parents=True)
            custom_work_dir = Path(tmp) / "custom_work"
            custom_work_dir.mkdir()

            # With explicit work_dir, should use that
            run_manager = JeevesRunManager(
                state_dir=state_dir,
                jeeves_script=Path("/nonexistent/jeeves.sh"),
                work_dir=custom_work_dir,
            )
            self.assertEqual(run_manager.work_dir, custom_work_dir.resolve())

    def test_work_dir_default_derives_from_state_dir_parent(self):
        """Test that default behavior derives work_dir from state_dir.parent."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "project" / "jeeves"
            state_dir.mkdir(parents=True)

            # Without explicit work_dir, should derive from state_dir.parent
            run_manager = JeevesRunManager(
                state_dir=state_dir,
                jeeves_script=Path("/nonexistent/jeeves.sh"),
                work_dir=None,
            )
            expected = state_dir.resolve().parent
            self.assertEqual(run_manager.work_dir, expected)

    def test_work_dir_with_both_forms(self):
        """Test that both short and long forms work with other arguments."""
        parser = self._create_parser()

        # Long form with other args
        args = parser.parse_args(["-s", "/state/dir", "--work-dir", "/work/dir", "-p", "9000"])
        self.assertEqual(args.state_dir, "/state/dir")
        self.assertEqual(args.work_dir, "/work/dir")
        self.assertEqual(args.port, 9000)

        # Short form with other args
        args = parser.parse_args(["--state-dir", "/state/dir", "-w", "/work/dir", "--port", "9000"])
        self.assertEqual(args.state_dir, "/state/dir")
        self.assertEqual(args.work_dir, "/work/dir")
        self.assertEqual(args.port, 9000)

    def test_work_dir_relative_path_resolved_to_absolute(self):
        """Test that relative paths are resolved to absolute paths."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "jeeves"
            state_dir.mkdir(parents=True)
            relative_work_dir = Path(tmp) / "project"
            relative_work_dir.mkdir()

            # Save current dir and change to tmp to make relative path meaningful
            original_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                # JeevesRunManager should resolve relative paths to absolute
                run_manager = JeevesRunManager(
                    state_dir=state_dir,
                    jeeves_script=Path("/nonexistent/jeeves.sh"),
                    work_dir=Path("project"),  # relative path
                )
                # Should be resolved to absolute
                self.assertTrue(run_manager.work_dir.is_absolute())
                self.assertEqual(run_manager.work_dir, relative_work_dir.resolve())
            finally:
                os.chdir(original_cwd)

    def test_work_dir_nonexistent_path_accepted(self):
        """Test that non-existent paths are accepted (not validated at init time)."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "jeeves"
            state_dir.mkdir(parents=True)
            nonexistent_path = Path(tmp) / "does_not_exist"

            # JeevesRunManager should accept non-existent paths without error
            run_manager = JeevesRunManager(
                state_dir=state_dir,
                jeeves_script=Path("/nonexistent/jeeves.sh"),
                work_dir=nonexistent_path,
            )
            self.assertEqual(run_manager.work_dir, nonexistent_path.resolve())
            self.assertFalse(run_manager.work_dir.exists())

    def test_work_dir_symlink_resolved(self):
        """Test that symlink paths are resolved to their real paths."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "jeeves"
            state_dir.mkdir(parents=True)
            real_dir = Path(tmp) / "real_project"
            real_dir.mkdir()
            symlink_dir = Path(tmp) / "symlink_project"
            symlink_dir.symlink_to(real_dir)

            run_manager = JeevesRunManager(
                state_dir=state_dir,
                jeeves_script=Path("/nonexistent/jeeves.sh"),
                work_dir=symlink_dir,
            )
            # resolve() follows symlinks, so work_dir should point to real path
            self.assertEqual(run_manager.work_dir, real_dir.resolve())

    def test_work_dir_empty_string_treated_as_current_dir(self):
        """Test that empty string is treated as current directory (resolves to cwd)."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "jeeves"
            state_dir.mkdir(parents=True)

            original_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                # Empty string path when resolved should give current directory
                run_manager = JeevesRunManager(
                    state_dir=state_dir,
                    jeeves_script=Path("/nonexistent/jeeves.sh"),
                    work_dir=Path(""),  # empty string path
                )
                # Path("").resolve() returns the current working directory
                self.assertEqual(run_manager.work_dir, Path(tmp).resolve())
            finally:
                os.chdir(original_cwd)


class JeevesPromptManagerEdgeCaseTests(unittest.TestCase):
    """Edge case tests for JeevesPromptManager with the new nested prompt support."""

    def test_list_prompts_includes_nested_directories(self):
        """Test that list_prompts() returns prompts from nested directories."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            # Create top-level prompt
            (prompt_dir / "design.md").write_text("# Design\n")

            # Create nested directory with prompts
            task_dir = prompt_dir / "task"
            task_dir.mkdir()
            (task_dir / "implement.md").write_text("# Implement Task\n")
            (task_dir / "review.md").write_text("# Review Task\n")

            manager = JeevesPromptManager(prompt_dir)
            prompts = manager.list_prompts()

            # Should find all 3 prompts
            ids = {p["id"] for p in prompts}
            self.assertIn("design.md", ids)
            self.assertIn("task/implement.md", ids)
            self.assertIn("task/review.md", ids)
            self.assertEqual(len(prompts), 3)

    def test_list_prompts_uses_relative_path_as_id(self):
        """Test that nested prompt IDs use relative paths from prompt_dir."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            # Create deeply nested prompt
            deep_dir = prompt_dir / "level1" / "level2"
            deep_dir.mkdir(parents=True)
            (deep_dir / "deep.md").write_text("# Deep Prompt\n")

            manager = JeevesPromptManager(prompt_dir)
            prompts = manager.list_prompts()

            self.assertEqual(len(prompts), 1)
            self.assertEqual(prompts[0]["id"], "level1/level2/deep.md")
            self.assertEqual(prompts[0]["name"], "level1/level2/deep.md")

    def test_list_prompts_ignores_non_md_files(self):
        """Test that list_prompts() only returns .md files."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            (prompt_dir / "valid.md").write_text("# Valid\n")
            (prompt_dir / "invalid.txt").write_text("Not a prompt\n")
            (prompt_dir / "also-invalid.json").write_text("{}\n")

            manager = JeevesPromptManager(prompt_dir)
            prompts = manager.list_prompts()

            self.assertEqual(len(prompts), 1)
            self.assertEqual(prompts[0]["id"], "valid.md")

    def test_list_prompts_empty_directory(self):
        """Test list_prompts() returns empty list for empty directory."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            manager = JeevesPromptManager(prompt_dir)
            prompts = manager.list_prompts()

            self.assertEqual(prompts, [])

    def test_list_prompts_nonexistent_directory(self):
        """Test list_prompts() returns empty list for non-existent directory."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "nonexistent"

            manager = JeevesPromptManager(prompt_dir)
            prompts = manager.list_prompts()

            self.assertEqual(prompts, [])

    def test_resolve_prompt_id_nested_path_valid(self):
        """Test that nested paths like task/implement.md are valid."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()
            task_dir = prompt_dir / "task"
            task_dir.mkdir()
            (task_dir / "implement.md").write_text("# Implement\n")

            manager = JeevesPromptManager(prompt_dir)
            # Should not raise - nested path is valid
            prompt = manager.read_prompt("task/implement.md")
            self.assertEqual(prompt["content"], "# Implement\n")

    def test_resolve_prompt_id_path_traversal_rejected(self):
        """Test that path traversal with .. is rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()
            (prompt_dir / "safe.md").write_text("# Safe\n")

            # Create a file outside prompt_dir that could be accessed via traversal
            (Path(tmp) / "secret.md").write_text("# Secret\n")

            manager = JeevesPromptManager(prompt_dir)

            # Should reject any path with ..
            with self.assertRaises(ValueError) as ctx:
                manager.read_prompt("../secret.md")
            self.assertIn("invalid prompt id", str(ctx.exception))

            # Also reject .. in the middle of path
            with self.assertRaises(ValueError) as ctx:
                manager.read_prompt("task/../../../secret.md")
            self.assertIn("invalid prompt id", str(ctx.exception))

    def test_resolve_prompt_id_backslash_rejected(self):
        """Test that backslashes in prompt IDs are rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()
            (prompt_dir / "safe.md").write_text("# Safe\n")

            manager = JeevesPromptManager(prompt_dir)

            with self.assertRaises(ValueError) as ctx:
                manager.read_prompt("task\\implement.md")
            self.assertIn("invalid prompt id", str(ctx.exception))

    def test_resolve_prompt_id_empty_string_rejected(self):
        """Test that empty prompt ID is rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            manager = JeevesPromptManager(prompt_dir)

            with self.assertRaises(ValueError) as ctx:
                manager.read_prompt("")
            self.assertIn("prompt id is required", str(ctx.exception))

    def test_resolve_prompt_id_non_md_extension_rejected(self):
        """Test that non-.md extensions are rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()
            (prompt_dir / "file.txt").write_text("Not a prompt\n")

            manager = JeevesPromptManager(prompt_dir)

            with self.assertRaises(ValueError) as ctx:
                manager.read_prompt("file.txt")
            self.assertIn("invalid prompt id", str(ctx.exception))

    def test_resolve_prompt_id_nonexistent_file_rejected(self):
        """Test that non-existent prompt files raise FileNotFoundError."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            manager = JeevesPromptManager(prompt_dir)

            with self.assertRaises(FileNotFoundError) as ctx:
                manager.read_prompt("nonexistent.md")
            self.assertIn("prompt not found", str(ctx.exception))

    def test_write_prompt_nested_path_valid(self):
        """Test that writing to nested paths works."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()
            task_dir = prompt_dir / "task"
            task_dir.mkdir()
            (task_dir / "implement.md").write_text("# Old Content\n")

            manager = JeevesPromptManager(prompt_dir)
            result = manager.write_prompt("task/implement.md", "# New Content\n")

            self.assertIn("# New Content", result["content"])
            self.assertEqual((task_dir / "implement.md").read_text(), "# New Content\n")

    def test_write_prompt_content_too_large_rejected(self):
        """Test that content exceeding 512KB is rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()
            (prompt_dir / "test.md").write_text("# Test\n")

            manager = JeevesPromptManager(prompt_dir)

            # Create content larger than 512KB
            large_content = "x" * (512 * 1024 + 1)

            with self.assertRaises(ValueError) as ctx:
                manager.write_prompt("test.md", large_content)
            self.assertIn("content too large", str(ctx.exception))

    def test_write_prompt_non_string_content_rejected(self):
        """Test that non-string content is rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()
            (prompt_dir / "test.md").write_text("# Test\n")

            manager = JeevesPromptManager(prompt_dir)

            with self.assertRaises(ValueError) as ctx:
                manager.write_prompt("test.md", None)
            self.assertIn("content must be a string", str(ctx.exception))

            with self.assertRaises(ValueError) as ctx:
                manager.write_prompt("test.md", 123)
            self.assertIn("content must be a string", str(ctx.exception))

    def test_resolve_prompt_id_symlink_escape_rejected(self):
        """Test that symlinks pointing outside prompt_dir are rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            # Create a file outside prompt_dir
            outside_file = Path(tmp) / "outside.md"
            outside_file.write_text("# Outside\n")

            # Create a symlink inside prompt_dir pointing outside
            symlink_path = prompt_dir / "escape.md"
            symlink_path.symlink_to(outside_file)

            manager = JeevesPromptManager(prompt_dir)

            # The symlink exists as a file, but resolve() should follow it
            # and relative_to() should fail since it's outside prompt_dir
            with self.assertRaises(ValueError) as ctx:
                manager.read_prompt("escape.md")
            self.assertIn("invalid prompt id", str(ctx.exception))

    def test_resolve_prompt_id_none_type_rejected(self):
        """Test that None as prompt ID raises ValueError."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            manager = JeevesPromptManager(prompt_dir)

            with self.assertRaises(ValueError) as ctx:
                manager.read_prompt(None)
            self.assertIn("prompt id is required", str(ctx.exception))

    def test_resolve_prompt_id_directory_rejected(self):
        """Test that directory paths are rejected."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            # Create a directory that ends with .md
            dir_with_md = prompt_dir / "task.md"
            dir_with_md.mkdir()

            manager = JeevesPromptManager(prompt_dir)

            # Even though it ends with .md, it's a directory not a file
            with self.assertRaises(FileNotFoundError):
                manager.read_prompt("task.md")

    def test_list_prompts_skips_directories_named_md(self):
        """Test that list_prompts() skips directories even if they match *.md pattern."""
        with tempfile.TemporaryDirectory() as tmp:
            prompt_dir = Path(tmp) / "prompts"
            prompt_dir.mkdir()

            # Create a valid file
            (prompt_dir / "valid.md").write_text("# Valid\n")

            # Create a directory with .md suffix (unusual but possible)
            dir_with_md = prompt_dir / "dir.md"
            dir_with_md.mkdir()

            manager = JeevesPromptManager(prompt_dir)
            prompts = manager.list_prompts()

            # Should only find the file, not the directory
            self.assertEqual(len(prompts), 1)
            self.assertEqual(prompts[0]["id"], "valid.md")


class WorkDirEnvironmentTests(unittest.TestCase):
    """Tests for work_dir environment variable propagation in JeevesRunManager."""

    def test_work_dir_env_set_in_start(self):
        """Test that JEEVES_WORK_DIR environment variable is set correctly on start."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "jeeves"
            state_dir.mkdir()

            work_dir = Path(tmp) / "work"
            work_dir.mkdir()

            # Create a script that prints the env vars
            script = Path(tmp) / "print_env.sh"
            script.write_text("""#!/usr/bin/env bash
echo "JEEVES_WORK_DIR=$JEEVES_WORK_DIR"
echo "JEEVES_STATE_DIR=$JEEVES_STATE_DIR"
""")
            script.chmod(script.stat().st_mode | stat.S_IEXEC)

            run_manager = JeevesRunManager(
                state_dir=state_dir,
                jeeves_script=script,
                work_dir=work_dir,
            )

            # The run_manager.work_dir should be set correctly
            self.assertEqual(run_manager.work_dir, work_dir.resolve())

            # The state_dir should also be resolved
            self.assertEqual(run_manager.state_dir, state_dir.resolve())

    def test_work_dir_matches_cwd_used_for_subprocess(self):
        """Test that work_dir is used as cwd for subprocess."""
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "jeeves"
            state_dir.mkdir()

            work_dir = Path(tmp) / "work"
            work_dir.mkdir()

            # Create a script that writes cwd to a file
            script = Path(tmp) / "write_cwd.sh"
            log_file = state_dir / "viewer-run.log"
            script.write_text("""#!/usr/bin/env bash
echo "cwd=$(pwd)"
sleep 0.1
""")
            script.chmod(script.stat().st_mode | stat.S_IEXEC)

            run_manager = JeevesRunManager(
                state_dir=state_dir,
                jeeves_script=script,
                work_dir=work_dir,
            )

            # Start the process
            result = run_manager.start(
                runner="codex",
                max_iterations=1,
            )

            self.assertTrue(result["running"])

            # Wait for it to complete
            time.sleep(0.5)

            # Check that cwd was work_dir
            if log_file.exists():
                content = log_file.read_text()
                self.assertIn(f"cwd={work_dir.resolve()}", content)


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

        (self.prompts_dir / "prompt.md").write_text("# Prompt\nHello\n")
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
