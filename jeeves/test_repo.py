"""Tests for repository operations."""

import subprocess
from unittest import mock
import pytest

from jeeves.repo import (
    is_gh_authenticated,
    check_gh_auth_for_browse,
    RepoError,
    AuthenticationError,
)


class TestIsGhAuthenticated:
    """Tests for is_gh_authenticated function."""

    def test_returns_true_when_authenticated(self):
        """Should return True when gh auth status succeeds."""
        with mock.patch("jeeves.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(returncode=0)
            assert is_gh_authenticated() is True

    def test_returns_false_when_not_authenticated(self):
        """Should return False when gh auth status fails."""
        with mock.patch("jeeves.repo.run_gh") as mock_run_gh:
            mock_run_gh.return_value = mock.Mock(returncode=1)
            assert is_gh_authenticated() is False

    def test_returns_false_when_gh_not_installed(self):
        """Should return False when gh CLI is not installed."""
        with mock.patch("jeeves.repo.run_gh") as mock_run_gh:
            mock_run_gh.side_effect = RepoError("gh not installed")
            assert is_gh_authenticated() is False


class TestCheckGhAuthForBrowse:
    """Tests for check_gh_auth_for_browse function."""

    def test_passes_when_authenticated(self):
        """Should not raise when authenticated."""
        with mock.patch("jeeves.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = True
            # Should not raise
            check_gh_auth_for_browse()

    def test_raises_auth_error_when_not_authenticated(self):
        """Should raise AuthenticationError with helpful message when not authenticated."""
        with mock.patch("jeeves.repo.is_gh_authenticated") as mock_auth:
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
        with mock.patch("jeeves.repo.is_gh_authenticated") as mock_auth:
            mock_auth.return_value = False
            with pytest.raises(AuthenticationError) as exc_info:
                check_gh_auth_for_browse()

            error_msg = str(exc_info.value)
            # Message should be clear and actionable
            assert len(error_msg) > 20  # Not just a generic error
