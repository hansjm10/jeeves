"""Tests for recent selections cache functionality."""

import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import pytest


class TestGetRecentFilePath:
    """Tests for get_recent_file_path function."""

    def test_returns_path_in_data_dir(self):
        """Should return path to recent.json in data directory."""
        from jeeves.core.browse import get_recent_file_path

        with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path("/fake/data")):
            path = get_recent_file_path()

        assert path == Path("/fake/data/recent.json")


class TestLoadRecentSelections:
    """Tests for load_recent_selections function."""

    def test_returns_empty_dict_when_file_not_exists(self):
        """Should return default structure when recent.json doesn't exist."""
        from jeeves.core.browse import load_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                result = load_recent_selections()

        assert result == {"repos": [], "maxRecent": 10}

    def test_loads_existing_file(self):
        """Should load existing recent.json file."""
        from jeeves.core.browse import load_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            recent_file = Path(tmpdir) / "recent.json"
            recent_file.write_text(json.dumps({
                "repos": [{"owner": "test", "repo": "project", "lastUsed": "2026-01-28T12:00:00Z"}],
                "maxRecent": 10
            }))

            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                result = load_recent_selections()

        assert len(result["repos"]) == 1
        assert result["repos"][0]["owner"] == "test"
        assert result["repos"][0]["repo"] == "project"

    def test_handles_corrupted_file(self):
        """Should return default structure when file is corrupted."""
        from jeeves.core.browse import load_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            recent_file = Path(tmpdir) / "recent.json"
            recent_file.write_text("not valid json {{{")

            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                result = load_recent_selections()

        assert result == {"repos": [], "maxRecent": 10}


class TestSaveRecentSelections:
    """Tests for save_recent_selections function."""

    def test_saves_to_file(self):
        """Should save selections to recent.json."""
        from jeeves.core.browse import save_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                data = {"repos": [{"owner": "test", "repo": "proj", "lastUsed": "2026-01-28T00:00:00Z"}], "maxRecent": 10}
                save_recent_selections(data)

                # Verify file was written
                recent_file = Path(tmpdir) / "recent.json"
                assert recent_file.exists()

                loaded = json.loads(recent_file.read_text())
                assert loaded["repos"][0]["owner"] == "test"

    def test_creates_directory_if_not_exists(self):
        """Should create data directory if it doesn't exist."""
        from jeeves.core.browse import save_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            new_dir = Path(tmpdir) / "new" / "nested" / "dir"

            with mock.patch("jeeves.core.browse.get_data_dir", return_value=new_dir):
                data = {"repos": [], "maxRecent": 10}
                save_recent_selections(data)

                assert (new_dir / "recent.json").exists()


class TestRecordRecentRepo:
    """Tests for record_recent_repo function."""

    def test_adds_new_repo_to_list(self):
        """Should add a new repository to the recent list."""
        from jeeves.core.browse import record_recent_repo, load_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                record_recent_repo("owner1", "repo1")

                result = load_recent_selections()
                assert len(result["repos"]) == 1
                assert result["repos"][0]["owner"] == "owner1"
                assert result["repos"][0]["repo"] == "repo1"
                assert "lastUsed" in result["repos"][0]

    def test_updates_existing_repo_timestamp(self):
        """Should update timestamp when repo already in list."""
        from jeeves.core.browse import record_recent_repo, load_recent_selections, save_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                # Pre-populate with old entry
                initial = {
                    "repos": [{"owner": "owner1", "repo": "repo1", "lastUsed": "2020-01-01T00:00:00Z"}],
                    "maxRecent": 10
                }
                save_recent_selections(initial)

                # Record same repo again
                record_recent_repo("owner1", "repo1")

                result = load_recent_selections()
                assert len(result["repos"]) == 1
                # Timestamp should be updated (newer than 2020)
                assert result["repos"][0]["lastUsed"] > "2020-01-01T00:00:00Z"

    def test_moves_existing_repo_to_front(self):
        """Should move existing repo to front of list when re-selected."""
        from jeeves.core.browse import record_recent_repo, load_recent_selections, save_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                # Pre-populate with multiple repos
                initial = {
                    "repos": [
                        {"owner": "owner1", "repo": "repo1", "lastUsed": "2026-01-28T10:00:00Z"},
                        {"owner": "owner2", "repo": "repo2", "lastUsed": "2026-01-27T10:00:00Z"},
                    ],
                    "maxRecent": 10
                }
                save_recent_selections(initial)

                # Record the second repo (should move to front)
                record_recent_repo("owner2", "repo2")

                result = load_recent_selections()
                assert result["repos"][0]["owner"] == "owner2"
                assert result["repos"][0]["repo"] == "repo2"

    def test_limits_to_max_recent(self):
        """Should limit list to maxRecent items."""
        from jeeves.core.browse import record_recent_repo, load_recent_selections, save_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                # Pre-populate with 10 repos (at limit)
                initial = {
                    "repos": [
                        {"owner": f"owner{i}", "repo": f"repo{i}", "lastUsed": f"2026-01-{10+i:02d}T00:00:00Z"}
                        for i in range(10)
                    ],
                    "maxRecent": 10
                }
                save_recent_selections(initial)

                # Add an 11th repo
                record_recent_repo("new_owner", "new_repo")

                result = load_recent_selections()
                assert len(result["repos"]) == 10
                # New repo should be first
                assert result["repos"][0]["owner"] == "new_owner"
                # Old repo should be dropped (oldest one)


class TestGetRecentRepos:
    """Tests for get_recent_repos function."""

    def test_returns_list_of_owner_repo_tuples(self):
        """Should return list of (owner, repo) tuples."""
        from jeeves.core.browse import get_recent_repos, save_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                data = {
                    "repos": [
                        {"owner": "org1", "repo": "proj1", "lastUsed": "2026-01-28T00:00:00Z"},
                        {"owner": "org2", "repo": "proj2", "lastUsed": "2026-01-27T00:00:00Z"},
                    ],
                    "maxRecent": 10
                }
                save_recent_selections(data)

                result = get_recent_repos()

        assert result == [("org1", "proj1"), ("org2", "proj2")]

    def test_returns_empty_list_when_no_recent(self):
        """Should return empty list when no recent repos."""
        from jeeves.core.browse import get_recent_repos

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                result = get_recent_repos()

        assert result == []


class TestSelectRepositoryWithRecent:
    """Tests for select_repository integration with recent repos."""

    def test_shows_recent_repos_first(self):
        """Should display recent repos before fetched repos."""
        from jeeves.core.browse import select_repository, save_recent_selections

        mock_repos = [
            {"name": "fetched-repo", "owner": "fetched-owner", "description": None, "updatedAt": None},
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                # Set up a recent repo
                data = {
                    "repos": [{"owner": "recent-owner", "repo": "recent-repo", "lastUsed": "2026-01-28T00:00:00Z"}],
                    "maxRecent": 10
                }
                save_recent_selections(data)

                with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                        select_repository()

                # First option should be the recent repo
                call_args = mock_prompt.call_args
                options = call_args[0][0]
                # Recent repo should appear first with a marker
                assert "recent-owner/recent-repo" in options[0] or "recent-repo" in options[0]

    def test_records_selection_to_recent(self):
        """Should record selected repo to recent list."""
        from jeeves.core.browse import select_repository, load_recent_selections

        mock_repos = [
            {"name": "selected-repo", "owner": "selected-owner", "description": None, "updatedAt": None},
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0):
                        owner, repo = select_repository()

                # Selection should be recorded
                result = load_recent_selections()
                assert len(result["repos"]) == 1
                assert result["repos"][0]["owner"] == "selected-owner"
                assert result["repos"][0]["repo"] == "selected-repo"

    def test_deduplicates_recent_and_fetched(self):
        """Should not show duplicate when repo is in both recent and fetched."""
        from jeeves.core.browse import select_repository, save_recent_selections

        mock_repos = [
            {"name": "my-repo", "owner": "my-owner", "description": None, "updatedAt": None},
            {"name": "other-repo", "owner": "other-owner", "description": None, "updatedAt": None},
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                # Set up same repo in recent
                data = {
                    "repos": [{"owner": "my-owner", "repo": "my-repo", "lastUsed": "2026-01-28T00:00:00Z"}],
                    "maxRecent": 10
                }
                save_recent_selections(data)

                with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                        select_repository()

                # Should have 2 options (not 3 - no duplicate)
                call_args = mock_prompt.call_args
                options = call_args[0][0]
                assert len(options) == 2


class TestLoadRecentSelectionsEdgeCases:
    """Edge case tests for load_recent_selections function."""

    def test_returns_default_when_file_contains_non_dict(self):
        """Should return default structure when file contains a list instead of dict."""
        from jeeves.core.browse import load_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            recent_file = Path(tmpdir) / "recent.json"
            # Write a valid JSON but not a dict
            recent_file.write_text(json.dumps(["not", "a", "dict"]))

            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                result = load_recent_selections()

        assert result == {"repos": [], "maxRecent": 10}

    def test_returns_default_when_file_missing_repos_key(self):
        """Should return default structure when file is dict but missing 'repos' key."""
        from jeeves.core.browse import load_recent_selections

        with tempfile.TemporaryDirectory() as tmpdir:
            recent_file = Path(tmpdir) / "recent.json"
            # Write a dict but missing the 'repos' key
            recent_file.write_text(json.dumps({"maxRecent": 10, "otherKey": "value"}))

            with mock.patch("jeeves.core.browse.get_data_dir", return_value=Path(tmpdir)):
                result = load_recent_selections()

        assert result == {"repos": [], "maxRecent": 10}


class TestSelectRepositoryLongDescriptions:
    """Tests for select_repository with long description truncation."""

    def test_truncates_long_descriptions(self):
        """Should truncate descriptions longer than 50 characters."""
        from jeeves.core.browse import select_repository

        mock_repos = [
            {
                "name": "my-repo",
                "owner": "testuser",
                "description": "This is a very long description that exceeds fifty characters and should be truncated with ellipsis",
                "updatedAt": None
            },
        ]

        with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
            with mock.patch("jeeves.core.browse.get_recent_repos", return_value=[]):
                with mock.patch("jeeves.core.browse.record_recent_repo"):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                        select_repository()

        # Check that prompt_choice was called with truncated description
        call_args = mock_prompt.call_args
        options = call_args[0][0]
        assert len(options) == 1
        # Description should be truncated with "..."
        assert "..." in options[0]
        # The option should not contain the full long description
        assert "should be truncated with ellipsis" not in options[0]

    def test_does_not_truncate_short_descriptions(self):
        """Should not truncate descriptions 50 characters or shorter."""
        from jeeves.core.browse import select_repository

        mock_repos = [
            {
                "name": "my-repo",
                "owner": "testuser",
                "description": "Short description under fifty chars",
                "updatedAt": None
            },
        ]

        with mock.patch("jeeves.core.browse.list_user_repos", return_value=mock_repos):
            with mock.patch("jeeves.core.browse.get_recent_repos", return_value=[]):
                with mock.patch("jeeves.core.browse.record_recent_repo"):
                    with mock.patch("jeeves.core.browse.prompt_choice", return_value=0) as mock_prompt:
                        select_repository()

        call_args = mock_prompt.call_args
        options = call_args[0][0]
        assert len(options) == 1
        # Short description should not be truncated
        assert "Short description under fifty chars" in options[0]
        # Should not have ellipsis
        assert "..." not in options[0]
