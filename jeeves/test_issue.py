"""Tests for GitHub issue listing functions."""

from unittest import mock
import pytest

from jeeves.issue import IssueError


class TestListGithubIssues:
    """Tests for list_github_issues function."""

    def test_returns_list_of_issues(self):
        """Should return a list of issue dictionaries."""
        from jeeves.issue import list_github_issues

        mock_output = """[
            {"number": 1, "title": "First issue", "labels": [{"name": "bug"}], "assignees": [{"login": "user1"}]},
            {"number": 2, "title": "Second issue", "labels": [], "assignees": []}
        ]"""

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout=mock_output, returncode=0)
            issues = list_github_issues("owner", "repo")

            assert len(issues) == 2
            assert issues[0]["number"] == 1
            assert issues[0]["title"] == "First issue"
            assert issues[0]["labels"] == ["bug"]
            assert issues[0]["assignees"] == ["user1"]

    def test_calls_gh_with_correct_args(self):
        """Should call gh issue list with --repo, --json, and --limit flags."""
        from jeeves.issue import list_github_issues

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_github_issues("testowner", "testrepo", limit=50)

            mock_run_gh.assert_called_once()
            call_args = mock_run_gh.call_args[0][0]
            assert "issue" in call_args
            assert "list" in call_args
            assert "--repo" in call_args
            assert "testowner/testrepo" in call_args
            assert "--json" in call_args
            assert "--limit" in call_args
            assert "50" in call_args

    def test_uses_state_parameter(self):
        """Should pass the state parameter to filter issues."""
        from jeeves.issue import list_github_issues

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_github_issues("owner", "repo", state="closed")

            call_args = mock_run_gh.call_args[0][0]
            assert "--state" in call_args
            assert "closed" in call_args

    def test_respects_limit_parameter(self):
        """Should pass the limit parameter to gh command."""
        from jeeves.issue import list_github_issues

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_github_issues("owner", "repo", limit=25)

            call_args = mock_run_gh.call_args[0][0]
            assert "25" in call_args

    def test_returns_empty_list_when_no_issues(self):
        """Should return empty list when repository has no issues."""
        from jeeves.issue import list_github_issues

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            issues = list_github_issues("owner", "repo")

            assert issues == []

    def test_raises_issue_error_on_failure(self):
        """Should raise IssueError when gh command fails."""
        from jeeves.issue import list_github_issues
        from jeeves.repo import RepoError

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.side_effect = RepoError("gh command failed")

            with pytest.raises(IssueError):
                list_github_issues("owner", "repo")

    def test_normalizes_labels_to_list_of_names(self):
        """Should convert label objects to list of label names."""
        from jeeves.issue import list_github_issues

        mock_output = """[
            {"number": 1, "title": "Issue with labels", "labels": [{"name": "bug"}, {"name": "urgent"}], "assignees": []}
        ]"""

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout=mock_output, returncode=0)
            issues = list_github_issues("owner", "repo")

            assert issues[0]["labels"] == ["bug", "urgent"]

    def test_normalizes_assignees_to_list_of_logins(self):
        """Should convert assignee objects to list of login names."""
        from jeeves.issue import list_github_issues

        mock_output = """[
            {"number": 1, "title": "Issue with assignees", "labels": [], "assignees": [{"login": "user1"}, {"login": "user2"}]}
        ]"""

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout=mock_output, returncode=0)
            issues = list_github_issues("owner", "repo")

            assert issues[0]["assignees"] == ["user1", "user2"]


class TestListAssignedIssues:
    """Tests for list_assigned_issues function."""

    def test_returns_list_of_assigned_issues(self):
        """Should return issues assigned to current user."""
        from jeeves.issue import list_assigned_issues

        mock_output = """[
            {"number": 5, "title": "My assigned issue", "labels": [{"name": "feature"}], "assignees": [{"login": "me"}]}
        ]"""

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout=mock_output, returncode=0)
            issues = list_assigned_issues("owner", "repo")

            assert len(issues) == 1
            assert issues[0]["number"] == 5
            assert issues[0]["title"] == "My assigned issue"

    def test_calls_gh_with_assignee_me_flag(self):
        """Should call gh issue list with --assignee @me flag."""
        from jeeves.issue import list_assigned_issues

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_assigned_issues("owner", "repo")

            mock_run_gh.assert_called_once()
            call_args = mock_run_gh.call_args[0][0]
            assert "--assignee" in call_args
            assert "@me" in call_args

    def test_returns_empty_list_when_no_assigned_issues(self):
        """Should return empty list when no issues are assigned to user."""
        from jeeves.issue import list_assigned_issues

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            issues = list_assigned_issues("owner", "repo")

            assert issues == []

    def test_uses_repo_parameter(self):
        """Should pass the owner/repo to gh command."""
        from jeeves.issue import list_assigned_issues

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_assigned_issues("myowner", "myrepo")

            call_args = mock_run_gh.call_args[0][0]
            assert "--repo" in call_args
            assert "myowner/myrepo" in call_args

    def test_raises_issue_error_on_failure(self):
        """Should raise IssueError when gh command fails."""
        from jeeves.issue import list_assigned_issues
        from jeeves.repo import RepoError

        with mock.patch("jeeves.issue.run_gh") as mock_run_gh:
            mock_run_gh.side_effect = RepoError("gh command failed")

            with pytest.raises(IssueError):
                list_assigned_issues("owner", "repo")
