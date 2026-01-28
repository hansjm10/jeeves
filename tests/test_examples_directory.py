"""Tests for examples directory."""

from pathlib import Path


def get_repo_root() -> Path:
    return Path(__file__).parent.parent


class TestExamplesDirectory:
    def test_examples_directory_exists(self) -> None:
        repo_root = get_repo_root()
        examples_dir = repo_root / "examples"
        assert examples_dir.is_dir(), f"examples/ directory not found at {examples_dir}"

    def test_issue_json_example_moved(self) -> None:
        repo_root = get_repo_root()
        example_file = repo_root / "examples" / "issue.json.example"
        assert example_file.is_file(), f"issue.json.example not found at {example_file}"
