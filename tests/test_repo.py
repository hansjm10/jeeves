"""Tests for repository operations."""

from unittest import mock
import pytest


class TestIsGhAuthenticated:
    def test_returns_true_when_authenticated(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(returncode=0)
            assert repo_module.is_gh_authenticated() is True

    def test_returns_false_when_not_authenticated(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(returncode=1)
            assert repo_module.is_gh_authenticated() is False

    def test_returns_false_when_gh_not_installed(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.side_effect = repo_module.RepoError("gh not installed")
            assert repo_module.is_gh_authenticated() is False


class TestCheckGhAuthForBrowse:
    def test_passes_when_authenticated(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = True
            repo_module.check_gh_auth_for_browse()

    def test_raises_auth_error_when_not_authenticated(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = False
            with pytest.raises(repo_module.AuthenticationError) as exc_info:
                repo_module.check_gh_auth_for_browse()

            error_msg = str(exc_info.value)
            assert "not authenticated" in error_msg.lower() or "authentication" in error_msg.lower()
            assert "gh auth login" in error_msg

    def test_error_message_is_user_friendly(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = False
            with pytest.raises(repo_module.AuthenticationError) as exc_info:
                repo_module.check_gh_auth_for_browse()

            error_msg = str(exc_info.value)
            assert len(error_msg) > 20


class TestListUserRepos:
    def test_returns_list_of_repos(self):
        from jeeves.core import repo as repo_module

        mock_output = """[
            {"name": "my-repo", "owner": {"login": "testuser"}, "description": "A test repo", "updatedAt": "2026-01-28T00:00:00Z"},
            {"name": "another-repo", "owner": {"login": "testuser"}, "description": "Another repo", "updatedAt": "2026-01-27T00:00:00Z"}
        ]"""

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout=mock_output, returncode=0)
            repos = repo_module.list_user_repos()

            assert len(repos) == 2
            assert repos[0]["name"] == "my-repo"
            assert repos[0]["owner"] == "testuser"
            assert repos[0]["description"] == "A test repo"
            assert repos[0]["updatedAt"] == "2026-01-28T00:00:00Z"

    def test_calls_gh_with_correct_args(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            repo_module.list_user_repos(limit=30)

            mock_run_gh.assert_called_once()
            call_args = mock_run_gh.call_args[0][0]
            assert "repo" in call_args
            assert "list" in call_args
            assert "--json" in call_args
            assert "--limit" in call_args
            assert "30" in call_args

    def test_respects_limit_parameter(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            repo_module.list_user_repos(limit=50)

            call_args = mock_run_gh.call_args[0][0]
            assert "50" in call_args

    def test_returns_empty_list_when_no_repos(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(stdout="[]", returncode=0)
            repos = repo_module.list_user_repos()

            assert repos == []

    def test_raises_repo_error_on_failure(self):
        from jeeves.core import repo as repo_module

        with mock.patch("jeeves.core.repo.run_gh") as mock_run_gh:
            mock_run_gh.side_effect = repo_module.RepoError("gh command failed")

            with pytest.raises(repo_module.RepoError):
                repo_module.list_user_repos()
