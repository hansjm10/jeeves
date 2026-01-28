# tests/test_issue_workflow.py
import pytest
import json
from pathlib import Path
from jeeves.core.issue import IssueState, GitHubIssue


class TestIssueStateWorkflow:
    def test_default_workflow(self):
        state = IssueState(
            owner="test",
            repo="repo",
            issue=GitHubIssue(number=1),
            branch="issue/1",
        )
        assert state.workflow == "default"

    def test_custom_workflow(self):
        state = IssueState(
            owner="test",
            repo="repo",
            issue=GitHubIssue(number=1),
            branch="issue/1",
            workflow="review-only",
        )
        assert state.workflow == "review-only"

    def test_workflow_in_to_dict(self):
        state = IssueState(
            owner="test",
            repo="repo",
            issue=GitHubIssue(number=1),
            branch="issue/1",
            workflow="custom",
        )
        data = state.to_dict()
        assert data["workflow"] == "custom"

    def test_workflow_from_dict(self):
        data = {
            "repo": "test/repo",
            "issue": {"number": 1},
            "branch": "issue/1",
            "workflow": "review-only",
        }
        state = IssueState.from_dict(data)
        assert state.workflow == "review-only"

    def test_workflow_defaults_in_from_dict(self):
        data = {
            "repo": "test/repo",
            "issue": {"number": 1},
            "branch": "issue/1",
        }
        state = IssueState.from_dict(data)
        assert state.workflow == "default"

    def test_create_issue_state_with_workflow(self, tmp_path, monkeypatch):
        """create_issue_state should pass workflow parameter to IssueState."""
        from jeeves.core.issue import create_issue_state
        from jeeves.core import paths

        # Mock the paths to use tmp_path
        monkeypatch.setattr(paths, "get_issue_state_dir", lambda owner, repo, issue: tmp_path)

        state = create_issue_state(
            owner="test",
            repo="repo",
            issue_number=1,
            workflow="custom-workflow",
            fetch_metadata=False,
            force=True,
        )

        assert state.workflow == "custom-workflow"

    def test_workflow_persists_through_save_load(self, tmp_path):
        """Workflow field should persist through save/load cycle."""
        state = IssueState(
            owner="test",
            repo="repo",
            issue=GitHubIssue(number=1),
            branch="issue/1",
            workflow="review-only",
        )
        state._state_dir = tmp_path
        state.save()

        # Load from file
        loaded = IssueState.load("test", "repo", 1, state_dir=tmp_path)
        assert loaded.workflow == "review-only"
