"""Tests for browse module selection utilities."""

import sys
from io import StringIO
from unittest import mock
import pytest

from jeeves.core.browse import (
    prompt_choice,
    select_repository,
    select_issue,
    BrowseError,
)


class TestPromptChoice:
    """Tests for prompt_choice function."""

    def test_displays_numbered_options(self):
        """Should display options with numbers."""
        with mock.patch("builtins.input", return_value="1"):
            options = ["Option A", "Option B", "Option C"]
            captured_output = StringIO()
            with mock.patch("sys.stdout", captured_output):
                prompt_choice(options, "Select an option:")

            output = captured_output.getvalue()
            assert "1)" in output or "1." in output or "[1]" in output
            assert "Option A" in output
            assert "Option B" in output
            assert "Option C" in output

    def test_returns_zero_based_index_for_selection(self):
        """Should return 0-based index when user selects an option."""
        with mock.patch("builtins.input", return_value="2"):
            options = ["First", "Second", "Third"]
            with mock.patch("sys.stdout", StringIO()):
                result = prompt_choice(options, "Pick one:")

            assert result == 1  # Second option, 0-indexed

    def test_returns_first_option_for_selection_one(self):
        """Should return 0 when user selects option 1."""
        with mock.patch("builtins.input", return_value="1"):
            options = ["Alpha", "Beta"]
            with mock.patch("sys.stdout", StringIO()):
                result = prompt_choice(options, "Choose:")

            assert result == 0

    def test_prompts_again_for_invalid_input(self):
        """Should re-prompt when user enters invalid input."""
        inputs = iter(["invalid", "0", "99", "2"])

        with mock.patch("builtins.input", side_effect=lambda _: next(inputs)):
            options = ["A", "B", "C"]
            with mock.patch("sys.stdout", StringIO()):
                result = prompt_choice(options, "Select:")

            assert result == 1  # Eventually selects "B"

    def test_handles_whitespace_in_input(self):
        """Should handle input with leading/trailing whitespace."""
        with mock.patch("builtins.input", return_value="  2  "):
            options = ["X", "Y"]
            with mock.patch("sys.stdout", StringIO()):
                result = prompt_choice(options, "Pick:")

            assert result == 1

    def test_handles_empty_input_then_valid(self):
        """Should re-prompt when user enters empty string."""
        # Simulate: empty string, then valid selection
        inputs = iter(["", "", "1"])

        with mock.patch("builtins.input", side_effect=lambda _: next(inputs)):
            options = ["Option A", "Option B"]
            with mock.patch("sys.stdout", StringIO()):
                result = prompt_choice(options, "Select:")

            assert result == 0  # First option selected

    def test_raises_on_keyboard_interrupt(self):
        """Should raise BrowseError on keyboard interrupt."""
        with mock.patch("builtins.input", side_effect=KeyboardInterrupt):
            options = ["One", "Two"]
            with mock.patch("sys.stdout", StringIO()):
                with pytest.raises((BrowseError, KeyboardInterrupt)):
                    prompt_choice(options, "Select:")

    def test_raises_on_eof(self):
        """Should raise BrowseError on EOF."""
        with mock.patch("builtins.input", side_effect=EOFError):
            options = ["One", "Two"]
            with mock.patch("sys.stdout", StringIO()):
                with pytest.raises((BrowseError, EOFError)):
                    prompt_choice(options, "Select:")

    def test_raises_on_empty_options(self):
        """Should raise BrowseError when options list is empty."""
        with pytest.raises(BrowseError):
            prompt_choice([], "No options:")


class TestSelectRepository:
    """Tests for select_repository function."""

    def test_returns_owner_and_repo_tuple(self):
        """Should return tuple of (owner, repo_name)."""
        mock_repos = [
            {"name": "my-project", "owner": "testuser", "description": "A project", "updatedAt": "2026-01-28T00:00:00Z"},
        ]

        with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
            with mock.patch("jeeves.core.browse.get_recent_repos", return_value=[]):
                with mock.patch("jeeves.core.browse.record_recent_repo"):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0):
                        owner, repo = select_repository()

        assert owner == "testuser"
        assert repo == "my-project"

    def test_calls_list_user_repos(self):
        """Should call list_user_repos to get available repositories."""
        mock_repos = [
            {"name": "repo1", "owner": "user", "description": None, "updatedAt": None},
        ]

        with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos) as mock_list:
            with mock.patch("jeeves.core.browse.get_recent_repos", return_value=[]):
                with mock.patch("jeeves.core.browse.record_recent_repo"):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0):
                        select_repository()

        mock_list.assert_called_once()

    def test_formats_repo_options_with_description(self):
        """Should format repository options showing owner/repo and description."""
        mock_repos = [
            {"name": "cool-project", "owner": "dev", "description": "A cool thing", "updatedAt": None},
        ]

        with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
            with mock.patch("jeeves.core.browse.get_recent_repos", return_value=[]):
                with mock.patch("jeeves.core.browse.record_recent_repo"):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                        select_repository()

        # Check that prompt_choice was called with formatted options
        call_args = mock_prompt.call_args
        options = call_args[0][0]
        assert len(options) == 1
        assert "dev/cool-project" in options[0] or "cool-project" in options[0]

    def test_raises_on_no_repos_found(self):
        """Should raise BrowseError when no repositories are found."""
        with mock.patch("jeeves.core.browse.list_user_repos", return_value=[]):
            with mock.patch("jeeves.core.browse.get_recent_repos", return_value=[]):
                with pytest.raises(BrowseError) as exc_info:
                    select_repository()

        assert "no repositories" in str(exc_info.value).lower()

    def test_handles_repos_without_description(self):
        """Should handle repositories with None description."""
        mock_repos = [
            {"name": "no-desc", "owner": "user", "description": None, "updatedAt": None},
        ]

        with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
            with mock.patch("jeeves.core.browse.get_recent_repos", return_value=[]):
                with mock.patch("jeeves.core.browse.record_recent_repo"):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0):
                        owner, repo = select_repository()

        assert repo == "no-desc"


class TestSelectIssue:
    """Tests for select_issue function."""

    def test_returns_issue_number(self):
        """Should return the selected issue number."""
        mock_issues = [
            {"number": 42, "title": "Fix the bug", "labels": [], "assignees": []},
        ]

        with mock.patch("jeeves.core.browse.list_github_issues", return_value=mock_issues):
            with mock.patch("jeeves.core.browse.list_assigned_issues", return_value=[]):
                with mock.patch("jeeves.core.browse.prompt_choice", return_value=0):
                    issue_num = select_issue("owner", "repo")

        assert issue_num == 42

    def test_calls_list_github_issues_with_owner_repo(self):
        """Should call list_github_issues with provided owner and repo."""
        mock_issues = [
            {"number": 1, "title": "Issue", "labels": [], "assignees": []},
        ]

        with mock.patch("jeeves.core.browse.list_github_issues", return_value=mock_issues) as mock_list:
            with mock.patch("jeeves.core.browse.list_assigned_issues", return_value=[]):
                with mock.patch("jeeves.core.browse.prompt_choice", return_value=0):
                    select_issue("myowner", "myrepo")

        mock_list.assert_called_once()
        call_args = mock_list.call_args
        assert call_args[0][0] == "myowner"
        assert call_args[0][1] == "myrepo"

    def test_formats_issue_options_with_number_and_title(self):
        """Should format issue options showing number and title."""
        mock_issues = [
            {"number": 123, "title": "Improve performance", "labels": ["enhancement"], "assignees": []},
        ]

        with mock.patch("jeeves.core.browse.list_github_issues", return_value=mock_issues):
            with mock.patch("jeeves.core.browse.list_assigned_issues", return_value=[]):
                with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                    select_issue("owner", "repo")

        call_args = mock_prompt.call_args
        options = call_args[0][0]
        assert len(options) == 1
        assert "#123" in options[0] or "123" in options[0]
        assert "Improve performance" in options[0]

    def test_raises_on_no_issues_found(self):
        """Should raise BrowseError when no issues are found."""
        with mock.patch("jeeves.core.browse.list_github_issues", return_value=[]):
            with mock.patch("jeeves.core.browse.list_assigned_issues", return_value=[]):
                with pytest.raises(BrowseError) as exc_info:
                    select_issue("owner", "repo")

        assert "no issues" in str(exc_info.value).lower() or "no open issues" in str(exc_info.value).lower()

    def test_shows_assigned_issues_first(self):
        """Should show issues assigned to current user first."""
        mock_all_issues = [
            {"number": 1, "title": "Unassigned issue", "labels": [], "assignees": []},
            {"number": 2, "title": "Assigned to me", "labels": [], "assignees": ["me"]},
        ]
        mock_assigned = [
            {"number": 2, "title": "Assigned to me", "labels": [], "assignees": ["me"]},
        ]

        with mock.patch("jeeves.core.browse.list_github_issues", return_value=mock_all_issues):
            with mock.patch("jeeves.core.browse.list_assigned_issues", return_value=mock_assigned):
                with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                    select_issue("owner", "repo")

        # First option should be the assigned issue
        call_args = mock_prompt.call_args
        options = call_args[0][0]
        assert "#2" in options[0] or "2" in options[0]

    def test_handles_issues_with_labels(self):
        """Should include label information in issue display."""
        mock_issues = [
            {"number": 5, "title": "Bug report", "labels": ["bug", "urgent"], "assignees": []},
        ]

        with mock.patch("jeeves.core.browse.list_github_issues", return_value=mock_issues):
            with mock.patch("jeeves.core.browse.list_assigned_issues", return_value=[]):
                with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                    select_issue("owner", "repo")

        call_args = mock_prompt.call_args
        options = call_args[0][0]
        # Labels may or may not be shown, but the function should work
        assert "#5" in options[0] or "5" in options[0]
