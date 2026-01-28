"""Tests for repository operations."""

import subprocess
from unittest import mock
import pytest

from jeeves.core.repo import (
    is_gh_authenticated,
    check_gh_auth_for_browse,
    RepoError,
    AuthenticationError,
)


class TestIsGhAuthenticated:
    """Tests for is_gh_authenticated function."""

    def test_returns_true_when_authenticated(self):
        """Should return True when gh auth status succeeds."""
        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(returncode=0)
            assert is_gh_authenticated() is True

    def test_returns_false_when_not_authenticated(self):
        """Should return False when gh auth status fails."""
        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(returncode=1)
            assert is_gh_authenticated() is False

    def test_returns_false_when_gh_not_installed(self):
        """Should return False when gh CLI is not installed."""
        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.side_effect = RepoError("gh not installed")
            assert is_gh_authenticated() is False


class TestCheckGhAuthForBrowse:
    """Tests for check_gh_auth_for_browse function."""

    def test_passes_when_authenticated(self):
        """Should not raise when authenticated."""
        with mock.patch("jeeves.core.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = True
            # Should not raise
            check_gh_auth_for_browse()

    def test_raises_auth_error_when_not_authenticated(self):
        """Should raise AuthenticationError with helpful message when not authenticated."""
        with mock.patch("jeeves.core.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = False
            with pytest.raises(AuthenticationError) as exc_info:
                check_gh_auth_for_browse()

            error_msg = str(exc_info.value)
            # Should mention authentication failure
            assert "not authenticated" in error_msg.lower() or "authentication" in error_msg.lower()
            # Should suggest running gh auth login
            assert "gh auth login" in error_msg

    def test_error_message_is_user_friendly(self):
        """Should provide a user-friendly error message."""
        with mock.patch("jeeves.core.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = False
            with pytest.raises(AuthenticationError) as exc_info:
                check_gh_auth_for_browse()

            error_msg = str(exc_info.value)
            # Message should be clear and actionable
            assert len(error_msg) > 20  # Not just a generic error


class TestListUserRepos:
    """Tests for list_user_repos function."""

    def test_returns_list_of_repos(self):
        """Should return a list of repository dictionaries."""
        from jeeves.core.repo import list_user_repos

        mock_output = """[
            {"name": "my-repo", "owner": {"login": "testuser"}, "description": "A test repo", "updatedAt": "2026-01-28T00:00:00Z"},
            {"name": "another-repo", "owner": {"login": "testuser"}, "description": "Another repo", "updatedAt": "2026-01-27T00:00:00Z"}
        ]"""

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout=mock_output, returncode=0)
            repos = list_user_repos()

            assert len(repos) == 2
            assert repos[0]["name"] == "my-repo"
            assert repos[0]["owner"] == "testuser"
            assert repos[0]["description"] == "A test repo"
            assert repos[0]["updatedAt"] == "2026-01-28T00:00:00Z"

    def test_calls_gh_with_correct_args(self):
        """Should call gh repo list with --json and --limit flags."""
        from jeeves.core.repo import list_user_repos

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_user_repos(limit=30)

            mock_run_gh.assert_called_once()
            call_args = mock_run_gh.call_args[0][0]
            assert "repo" in call_args
            assert "list" in call_args
            assert "--json" in call_args
            assert "--limit" in call_args
            assert "30" in call_args

    def test_respects_limit_parameter(self):
        """Should pass the limit parameter to gh command."""
        from jeeves.core.repo import list_user_repos

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_user_repos(limit=50)

            call_args = mock_run_gh.call_args[0][0]
            assert "50" in call_args

    def test_returns_empty_list_when_no_repos(self):
        """Should return empty list when user has no repositories."""
        from jeeves.core.repo import list_user_repos

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            repos = list_user_repos()

            assert repos == []

    def test_raises_repo_error_on_failure(self):
        """Should raise RepoError when gh command fails."""
        from jeeves.core.repo import list_user_repos

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.side_effect = RepoError("gh command failed")

            with pytest.raises(RepoError):
                list_user_repos()


class TestListContributedRepos:
    """Tests for list_contributed_repos function."""

    def test_returns_list_of_contributed_repos(self):
        """Should return a list of repos user has contributed to."""
        from jeeves.core.repo import list_contributed_repos

        mock_output = """[
            {"name": "open-source-lib", "owner": {"login": "other-org"}, "description": "An OSS project", "updatedAt": "2026-01-28T00:00:00Z"}
        ]"""

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout=mock_output, returncode=0)
            repos = list_contributed_repos()

            assert len(repos) == 1
            assert repos[0]["name"] == "open-source-lib"
            assert repos[0]["owner"] == "other-org"

    def test_calls_gh_with_source_flag(self):
        """Should call gh repo list with --source flag to get contributed repos."""
        from jeeves.core.repo import list_contributed_repos

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_contributed_repos()

            mock_run_gh.assert_called_once()
            call_args = mock_run_gh.call_args[0][0]
            assert "--source" in call_args

    def test_respects_limit_parameter(self):
        """Should pass the limit parameter to gh command."""
        from jeeves.core.repo import list_contributed_repos

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            list_contributed_repos(limit=25)

            call_args = mock_run_gh.call_args[0][0]
            assert "25" in call_args

    def test_returns_empty_list_when_no_contributions(self):
        """Should return empty list when user has no contributions."""
        from jeeves.core.repo import list_contributed_repos

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            repos = list_contributed_repos()

            assert repos == []
