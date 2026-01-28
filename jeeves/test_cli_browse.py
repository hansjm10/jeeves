"""Tests for --browse flag in CLI init command."""

from unittest import mock

import pytest
from click.testing import CliRunner

from jeeves.cli import main
from jeeves.browse import BrowseError
from jeeves.repo import AuthenticationError


class TestInitBrowseFlag:
    """Tests for jeeves init --browse flag."""

    @pytest.fixture
    def runner(self):
        """Create a CLI test runner."""
        return CliRunner()

    def test_browse_flag_exists_in_help(self, runner):
        """Should show --browse flag in init help."""
        result = runner.invoke(main, ["init", "--help"])
        assert result.exit_code == 0
        assert "--browse" in result.output

    def test_browse_invokes_auth_check(self, runner):
        """Should check authentication before browse operation."""
        with mock.patch("jeeves.cli.check_gh_auth_for_browse") as mock_auth:
            mock_auth.side_effect = AuthenticationError("Not authenticated")
            result = runner.invoke(main, ["init", "--browse"])

        mock_auth.assert_called_once()
        assert result.exit_code != 0
        assert "Not authenticated" in result.output or "authenticated" in result.output.lower()

    def test_browse_invokes_select_repository(self, runner):
        """Should call select_repository when --browse is used."""
        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository", return_value=("owner", "repo")) as mock_select:
                with mock.patch("jeeves.cli.select_issue", return_value=42):
                    with mock.patch("jeeves.cli.ensure_repo"):
                        with mock.patch("jeeves.cli.create_issue_state"):
                            with mock.patch("jeeves.cli.create_worktree"):
                                runner.invoke(main, ["init", "--browse"])

        mock_select.assert_called_once()

    def test_browse_invokes_select_issue_after_repo(self, runner):
        """Should call select_issue with selected repo after repo selection."""
        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository", return_value=("testowner", "testrepo")):
                with mock.patch("jeeves.cli.select_issue", return_value=123) as mock_select_issue:
                    with mock.patch("jeeves.cli.ensure_repo"):
                        with mock.patch("jeeves.cli.create_issue_state"):
                            with mock.patch("jeeves.cli.create_worktree"):
                                runner.invoke(main, ["init", "--browse"])

        mock_select_issue.assert_called_once_with("testowner", "testrepo")

    def test_browse_continues_with_init_flow(self, runner):
        """Should continue with normal init flow after selection."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository", return_value=("owner", "repo")):
                with mock.patch("jeeves.cli.select_issue", return_value=42):
                    with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo") as mock_ensure:
                        with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state) as mock_create_state:
                            with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                                result = runner.invoke(main, ["init", "--browse"])

        # Verify init flow was called with selected values
        mock_ensure.assert_called_once()
        mock_create_state.assert_called_once()
        call_kwargs = mock_create_state.call_args[1]
        assert call_kwargs["owner"] == "owner"
        assert call_kwargs["repo"] == "repo"
        assert call_kwargs["issue_number"] == 42

    def test_browse_handles_repository_selection_cancel(self, runner):
        """Should handle user cancelling repository selection."""
        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository", side_effect=BrowseError("Selection cancelled")):
                result = runner.invoke(main, ["init", "--browse"])

        assert result.exit_code != 0
        assert "cancel" in result.output.lower() or "Selection cancelled" in result.output

    def test_browse_handles_issue_selection_cancel(self, runner):
        """Should handle user cancelling issue selection."""
        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository", return_value=("owner", "repo")):
                with mock.patch("jeeves.cli.select_issue", side_effect=BrowseError("Selection cancelled")):
                    result = runner.invoke(main, ["init", "--browse"])

        assert result.exit_code != 0
        assert "cancel" in result.output.lower() or "Selection cancelled" in result.output

    def test_browse_and_repo_mutually_exclusive(self, runner):
        """Should not allow both --browse and --repo flags."""
        result = runner.invoke(main, ["init", "--browse", "--repo", "owner/repo"])

        # Either error on conflicting flags or handle gracefully
        # Based on design doc question, we'll make browse override repo if both are provided
        # OR we reject the combination
        assert result.exit_code != 0 or "--browse" in result.output or "cannot" in result.output.lower()

    def test_browse_without_repo_or_issue_flags(self, runner):
        """Should work without --repo and --issue when --browse is provided."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository", return_value=("owner", "repo")):
                with mock.patch("jeeves.cli.select_issue", return_value=42):
                    with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo"):
                        with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                            with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                                result = runner.invoke(main, ["init", "--browse"])

        # Should succeed without --repo and --issue
        assert result.exit_code == 0

    def test_browse_shows_ready_message_on_success(self, runner):
        """Should show Ready! message after successful browse init."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository", return_value=("owner", "repo")):
                with mock.patch("jeeves.cli.select_issue", return_value=42):
                    with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo"):
                        with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                            with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                                result = runner.invoke(main, ["init", "--browse"])

        assert "Ready!" in result.output

    def test_existing_repo_issue_flags_still_work(self, runner):
        """Should not break existing --repo and --issue flag behavior."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo"):
            with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                    result = runner.invoke(main, ["init", "--repo", "owner/repo", "--issue", "42"])

        # Should succeed with traditional flags
        assert result.exit_code == 0


class TestInitBrowseIssuesFlag:
    """Tests for jeeves init --browse-issues flag."""

    @pytest.fixture
    def runner(self):
        """Create a CLI test runner."""
        return CliRunner()

    def test_browse_issues_flag_exists_in_help(self, runner):
        """Should show --browse-issues flag in init help."""
        result = runner.invoke(main, ["init", "--help"])
        assert result.exit_code == 0
        assert "--browse-issues" in result.output

    def test_browse_issues_requires_repo_flag(self, runner):
        """Should require --repo when using --browse-issues."""
        result = runner.invoke(main, ["init", "--browse-issues"])
        assert result.exit_code != 0
        assert "--repo" in result.output or "repo" in result.output.lower()

    def test_browse_issues_invokes_auth_check(self, runner):
        """Should check authentication before browse-issues operation."""
        with mock.patch("jeeves.cli.check_gh_auth_for_browse") as mock_auth:
            mock_auth.side_effect = AuthenticationError("Not authenticated")
            result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        mock_auth.assert_called_once()
        assert result.exit_code != 0
        assert "Not authenticated" in result.output or "authenticated" in result.output.lower()

    def test_browse_issues_invokes_select_issue(self, runner):
        """Should call select_issue when --browse-issues is used."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_issue", return_value=42) as mock_select_issue:
                with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo"):
                    with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                        with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                            runner.invoke(main, ["init", "--repo", "testowner/testrepo", "--browse-issues"])

        mock_select_issue.assert_called_once_with("testowner", "testrepo")

    def test_browse_issues_does_not_call_select_repository(self, runner):
        """Should not call select_repository when --browse-issues is used (repo is already known)."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_repository") as mock_select_repo:
                with mock.patch("jeeves.cli.select_issue", return_value=42):
                    with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo"):
                        with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                            with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                                runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        mock_select_repo.assert_not_called()

    def test_browse_issues_continues_with_init_flow(self, runner):
        """Should continue with normal init flow after issue selection."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_issue", return_value=42):
                with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo") as mock_ensure:
                    with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state) as mock_create_state:
                        with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                            result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        # Verify init flow was called with selected values
        mock_ensure.assert_called_once()
        mock_create_state.assert_called_once()
        call_kwargs = mock_create_state.call_args[1]
        assert call_kwargs["owner"] == "owner"
        assert call_kwargs["repo"] == "repo"
        assert call_kwargs["issue_number"] == 42

    def test_browse_issues_handles_selection_cancel(self, runner):
        """Should handle user cancelling issue selection."""
        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_issue", side_effect=BrowseError("Selection cancelled")):
                result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        assert result.exit_code != 0
        assert "cancel" in result.output.lower() or "Selection cancelled" in result.output

    def test_browse_issues_and_issue_mutually_exclusive(self, runner):
        """Should not allow both --browse-issues and --issue flags."""
        result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues", "--issue", "123"])

        # Should reject the combination
        assert result.exit_code != 0
        assert "--browse-issues" in result.output or "--issue" in result.output or "cannot" in result.output.lower()

    def test_browse_issues_shows_ready_message_on_success(self, runner):
        """Should show Ready! message after successful browse-issues init."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_issue", return_value=42):
                with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo"):
                    with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                        with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                            result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        assert "Ready!" in result.output

    def test_browse_issues_displays_selected_issue(self, runner):
        """Should display the selected issue number."""
        mock_state = mock.MagicMock()
        mock_state.state_dir = "/tmp/state"
        mock_state.issue.title = "Test Issue"
        mock_state.branch_name = "issue/42"

        with mock.patch("jeeves.cli.check_gh_auth_for_browse"):
            with mock.patch("jeeves.cli.select_issue", return_value=42):
                with mock.patch("jeeves.cli.ensure_repo", return_value="/tmp/repo"):
                    with mock.patch("jeeves.cli.create_issue_state", return_value=mock_state):
                        with mock.patch("jeeves.cli.create_worktree", return_value="/tmp/worktree"):
                            result = runner.invoke(main, ["init", "--repo", "owner/repo", "--browse-issues"])

        assert "Selected issue: #42" in result.output or "#42" in result.output
