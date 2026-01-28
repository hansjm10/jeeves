"""Integration tests for browse flows with mocked gh CLI subprocess calls.

These tests simulate end-to-end flows by mocking subprocess.run to simulate
gh CLI responses, testing the complete integration from CLI through browse
functions to subprocess calls.
"""

import json
import subprocess
import tempfile
from io import StringIO
from pathlib import Path
from unittest import mock

import pytest
from click.testing import CliRunner

from jeeves.cli import main


class MockSubprocessResult:
    """Helper to create mock subprocess.CompletedProcess results."""

    @staticmethod
    def success(stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
        """Create a successful subprocess result."""
        return subprocess.CompletedProcess(
            args=[], returncode=0, stdout=stdout, stderr=stderr
        )

    @staticmethod
    def failure(stderr: str = "error", returncode: int = 1) -> subprocess.CompletedProcess:
        """Create a failed subprocess result."""
        return subprocess.CompletedProcess(
            args=[], returncode=returncode, stdout="", stderr=stderr
        )


def mock_gh_responses(
    auth_status: bool = True,
    repos: list | None = None,
    issues: list | None = None,
    assigned_issues: list | None = None,
):
    """Create a mock function that simulates gh CLI responses.

    Args:
        auth_status: Whether auth status should succeed.
        repos: List of repo dicts to return from 'gh repo list'.
        issues: List of issue dicts to return from 'gh issue list'.
        assigned_issues: List of assigned issue dicts.

    Returns:
        A side_effect function for subprocess.run mock.
    """
    if repos is None:
        repos = []
    if issues is None:
        issues = []
    if assigned_issues is None:
        assigned_issues = []

    def side_effect(cmd, **kwargs):
        """Handle subprocess.run calls based on command."""
        if not isinstance(cmd, list):
            cmd = [cmd]

        cmd_str = " ".join(cmd)

        # gh auth status
        if "gh" in cmd and "auth" in cmd and "status" in cmd:
            if auth_status:
                return MockSubprocessResult.success("Logged in to github.com")
            else:
                return MockSubprocessResult.failure("not logged into any GitHub hosts")

        # gh repo list
        if "gh" in cmd and "repo" in cmd and "list" in cmd:
            return MockSubprocessResult.success(json.dumps(repos))

        # gh issue list --assignee
        if "gh" in cmd and "issue" in cmd and "list" in cmd and "--assignee" in cmd:
            return MockSubprocessResult.success(json.dumps(assigned_issues))

        # gh issue list (general)
        if "gh" in cmd and "issue" in cmd and "list" in cmd:
            return MockSubprocessResult.success(json.dumps(issues))

        # gh repo clone
        if "gh" in cmd and "repo" in cmd and "clone" in cmd:
            return MockSubprocessResult.success()

        # git commands
        if "git" in cmd:
            return MockSubprocessResult.success()

        # Default: return success
        return MockSubprocessResult.success()

    return side_effect


class TestBrowseFlowIntegration:
    """Integration tests for --browse flag with mocked gh CLI."""

    @pytest.fixture
    def runner(self):
        """Create a CLI test runner."""
        return CliRunner()

    @pytest.fixture
    def temp_data_dir(self):
        """Create a temporary data directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)

    def test_browse_flow_with_mocked_gh_auth(self, runner, temp_data_dir):
        """Should check gh auth status via subprocess."""
        repos = [
            {"name": "my-repo", "owner": {"login": "testuser"}, "description": "A repo", "updatedAt": "2026-01-28T00:00:00Z"}
        ]

        with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=False, repos=repos)):
            result = runner.invoke(main, ["init", "--browse"])

        assert result.exit_code != 0
        assert "not authenticated" in result.output.lower() or "gh auth login" in result.output

    def test_browse_flow_with_mocked_repo_list(self, runner, temp_data_dir):
        """Should list repos via gh repo list subprocess call."""
        repos = [
            {"name": "project-one", "owner": {"login": "testorg"}, "description": "First project", "updatedAt": "2026-01-28T00:00:00Z"},
            {"name": "project-two", "owner": {"login": "testorg"}, "description": "Second project", "updatedAt": "2026-01-27T00:00:00Z"},
        ]
        issues = [
            {"number": 42, "title": "Fix the bug", "labels": [{"name": "bug"}], "assignees": []}
        ]

        # Mock subprocess calls and input
        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, repos=repos, issues=issues)):
                # Mock user input: select repo 1, then issue 1
                with mock.patch("builtins.input", side_effect=["1", "1"]):
                    with mock.patch("sys.stdout", StringIO()):
                        with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                            mock_state = mock.MagicMock()
                            mock_state.state_dir = temp_data_dir / "state"
                            mock_state.issue.title = "Fix the bug"
                            mock_state.branch_name = "issue/42"
                            with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                                with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                    result = runner.invoke(main, ["init", "--browse"])

        assert result.exit_code == 0
        assert "Ready!" in result.output

    def test_browse_flow_auth_failure_shows_helpful_message(self, runner):
        """Should show helpful auth message when gh CLI not authenticated."""
        with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=False)):
            result = runner.invoke(main, ["init", "--browse"])

        assert result.exit_code != 0
        # Should suggest running gh auth login
        assert "gh auth login" in result.output


class TestBrowseIssuesFlowIntegration:
    """Integration tests for --browse-issues flag with mocked gh CLI."""

    @pytest.fixture
    def runner(self):
        """Create a CLI test runner."""
        return CliRunner()

    @pytest.fixture
    def temp_data_dir(self):
        """Create a temporary data directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)

    def test_browse_issues_flow_with_mocked_gh_issue_list(self, runner, temp_data_dir):
        """Should list issues via gh issue list subprocess call."""
        issues = [
            {"number": 123, "title": "Add new feature", "labels": [{"name": "enhancement"}], "assignees": []},
            {"number": 456, "title": "Fix critical bug", "labels": [{"name": "bug"}], "assignees": []},
        ]

        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, issues=issues)):
                with mock.patch("builtins.input", return_value="1"):
                    with mock.patch("sys.stdout", StringIO()):
                        with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                            mock_state = mock.MagicMock()
                            mock_state.state_dir = temp_data_dir / "state"
                            mock_state.issue.title = "Add new feature"
                            mock_state.branch_name = "issue/123"
                            with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                                with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                    result = runner.invoke(main, ["init", "--repo", "testorg/testrepo", "--browse-issues"])

        assert result.exit_code == 0
        assert "Selected issue: #123" in result.output
        assert "Ready!" in result.output

    def test_browse_issues_shows_assigned_issues_first(self, runner, temp_data_dir):
        """Should show assigned issues first in the list."""
        issues = [
            {"number": 100, "title": "Unassigned task", "labels": [], "assignees": []},
            {"number": 200, "title": "My assigned task", "labels": [], "assignees": [{"login": "me"}]},
        ]
        assigned_issues = [
            {"number": 200, "title": "My assigned task", "labels": [], "assignees": [{"login": "me"}]},
        ]

        captured_options = []
        original_prompt_choice = None

        def capture_prompt_choice(options, prompt):
            """Capture the options passed to prompt_choice."""
            captured_options.extend(options)
            return 0  # Select first option

        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, issues=issues, assigned_issues=assigned_issues)):
                with mock.patch("jeeves.browse.prompt_choice", side_effect=capture_prompt_choice):
                    with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                        mock_state = mock.MagicMock()
                        mock_state.state_dir = temp_data_dir / "state"
                        mock_state.issue.title = "My assigned task"
                        mock_state.branch_name = "issue/200"
                        with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                            with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                result = runner.invoke(main, ["init", "--repo", "testorg/testrepo", "--browse-issues"])

        # First option should be the assigned issue (#200)
        assert len(captured_options) > 0
        assert "#200" in captured_options[0] or "200" in captured_options[0]

    def test_browse_issues_auth_failure(self, runner):
        """Should fail with helpful message when not authenticated."""
        with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=False)):
            result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        assert result.exit_code != 0
        assert "gh auth login" in result.output


class TestInteractiveFlowIntegration:
    """Integration tests for --interactive / -i flag with mocked gh CLI."""

    @pytest.fixture
    def runner(self):
        """Create a CLI test runner."""
        return CliRunner()

    @pytest.fixture
    def temp_data_dir(self):
        """Create a temporary data directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)

    def test_interactive_flow_full_selection(self, runner, temp_data_dir):
        """Should walk through repo and issue selection in interactive mode."""
        repos = [
            {"name": "my-project", "owner": {"login": "myorg"}, "description": "My project", "updatedAt": "2026-01-28T00:00:00Z"}
        ]
        issues = [
            {"number": 99, "title": "Interactive task", "labels": [], "assignees": []}
        ]

        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, repos=repos, issues=issues)):
                with mock.patch("builtins.input", side_effect=["1", "1"]):
                    with mock.patch("sys.stdout", StringIO()):
                        with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                            mock_state = mock.MagicMock()
                            mock_state.state_dir = temp_data_dir / "state"
                            mock_state.issue.title = "Interactive task"
                            mock_state.branch_name = "issue/99"
                            with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                                with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                    result = runner.invoke(main, ["init", "-i"])

        assert result.exit_code == 0
        assert "Ready!" in result.output

    def test_interactive_flow_skips_repo_when_provided(self, runner, temp_data_dir):
        """Should skip repo selection when --repo is provided with -i."""
        issues = [
            {"number": 77, "title": "Task when repo provided", "labels": [], "assignees": []}
        ]

        select_repository_called = False

        def mock_select_repository():
            nonlocal select_repository_called
            select_repository_called = True
            return ("should", "not_be_called")

        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, issues=issues)):
                with mock.patch("builtins.input", return_value="1"):
                    with mock.patch("sys.stdout", StringIO()):
                        with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                            mock_state = mock.MagicMock()
                            mock_state.state_dir = temp_data_dir / "state"
                            mock_state.issue.title = "Task when repo provided"
                            mock_state.branch_name = "issue/77"
                            with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                                with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                    with mock.patch("jeeves.cli.select_repository", side_effect=mock_select_repository):
                                        result = runner.invoke(main, ["init", "-i", "--repo", "provided/repo"])

        assert result.exit_code == 0
        assert not select_repository_called

    def test_interactive_flow_skips_issue_when_provided(self, runner, temp_data_dir):
        """Should skip issue selection when --issue is provided with -i."""
        repos = [
            {"name": "my-repo", "owner": {"login": "myorg"}, "description": "My repo", "updatedAt": "2026-01-28T00:00:00Z"}
        ]

        select_issue_called = False

        def mock_select_issue(owner, repo):
            nonlocal select_issue_called
            select_issue_called = True
            return 999

        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, repos=repos)):
                with mock.patch("builtins.input", return_value="1"):
                    with mock.patch("sys.stdout", StringIO()):
                        with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                            mock_state = mock.MagicMock()
                            mock_state.state_dir = temp_data_dir / "state"
                            mock_state.issue.title = "Pre-provided issue"
                            mock_state.branch_name = "issue/55"
                            with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                                with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                    with mock.patch("jeeves.cli.select_issue", side_effect=mock_select_issue):
                                        result = runner.invoke(main, ["init", "-i", "--issue", "55"])

        assert result.exit_code == 0
        assert not select_issue_called

    def test_interactive_auth_failure(self, runner):
        """Should fail with helpful message when not authenticated."""
        with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=False)):
            result = runner.invoke(main, ["init", "--interactive"])

        assert result.exit_code != 0
        assert "gh auth login" in result.output


class TestNoReposOrIssuesEdgeCases:
    """Integration tests for edge cases with no repos or no issues."""

    @pytest.fixture
    def runner(self):
        """Create a CLI test runner."""
        return CliRunner()

    @pytest.fixture
    def temp_data_dir(self):
        """Create a temporary data directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)

    def test_browse_with_no_repos_shows_error(self, runner, temp_data_dir):
        """Should show helpful error when user has no repositories."""
        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, repos=[])):
                result = runner.invoke(main, ["init", "--browse"])

        assert result.exit_code != 0
        assert "no repositories" in result.output.lower()

    def test_browse_issues_with_no_issues_shows_error(self, runner, temp_data_dir):
        """Should show helpful error when repo has no open issues."""
        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, issues=[])):
                result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        assert result.exit_code != 0
        assert "no" in result.output.lower() and "issue" in result.output.lower()


class TestRecentCacheIntegration:
    """Integration tests for recent selections cache with browse flows."""

    @pytest.fixture
    def runner(self):
        """Create a CLI test runner."""
        return CliRunner()

    @pytest.fixture
    def temp_data_dir(self):
        """Create a temporary data directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir)

    def test_browse_records_selection_to_recent(self, runner, temp_data_dir):
        """Should record selected repo to recent cache."""
        from jeeves.browse import load_recent_selections

        repos = [
            {"name": "selected-project", "owner": {"login": "selected-org"}, "description": "A project", "updatedAt": "2026-01-28T00:00:00Z"}
        ]
        issues = [
            {"number": 1, "title": "First issue", "labels": [], "assignees": []}
        ]

        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, repos=repos, issues=issues)):
                with mock.patch("builtins.input", side_effect=["1", "1"]):
                    with mock.patch("sys.stdout", StringIO()):
                        with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                            mock_state = mock.MagicMock()
                            mock_state.state_dir = temp_data_dir / "state"
                            mock_state.issue.title = "First issue"
                            mock_state.branch_name = "issue/1"
                            with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                                with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                    result = runner.invoke(main, ["init", "--browse"])

            # Check that selection was recorded
            recent = load_recent_selections()
            assert len(recent["repos"]) == 1
            assert recent["repos"][0]["owner"] == "selected-org"
            assert recent["repos"][0]["repo"] == "selected-project"

    def test_browse_shows_recent_repos_first(self, runner, temp_data_dir):
        """Should show recently selected repos first in the list."""
        from jeeves.browse import save_recent_selections

        repos = [
            {"name": "new-repo", "owner": {"login": "new-owner"}, "description": "New repo", "updatedAt": "2026-01-28T00:00:00Z"}
        ]
        issues = [
            {"number": 1, "title": "Issue", "labels": [], "assignees": []}
        ]

        captured_options = []

        def capture_prompt_choice(options, prompt):
            captured_options.extend(options)
            return 0

        with mock.patch("jeeves.browse.get_data_dir", return_value=temp_data_dir):
            # Pre-populate recent cache
            save_recent_selections({
                "repos": [{"owner": "recent-owner", "repo": "recent-repo", "lastUsed": "2026-01-28T00:00:00Z"}],
                "maxRecent": 10
            })

            with mock.patch("subprocess.run", side_effect=mock_gh_responses(auth_status=True, repos=repos, issues=issues)):
                with mock.patch("jeeves.browse.prompt_choice", side_effect=capture_prompt_choice):
                    with mock.patch("jeeves.cli.ensure_repo", return_value=temp_data_dir / "repo"):
                        mock_state = mock.MagicMock()
                        mock_state.state_dir = temp_data_dir / "state"
                        mock_state.issue.title = "Issue"
                        mock_state.branch_name = "issue/1"
                        with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                            with mock.patch("jeeves.cli.create_worktree", return_value=temp_data_dir / "worktree"):
                                result = runner.invoke(main, ["init", "--browse"])

        # First option should be the recent repo
        assert len(captured_options) >= 2  # Repo options
        # First should be recent-owner/recent-repo (with recent marker)
        assert "recent-owner/recent-repo" in captured_options[0] or "recent-repo" in captured_options[0]
        assert "(recent)" in captured_options[0]
