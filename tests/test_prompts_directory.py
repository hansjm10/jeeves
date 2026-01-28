"""Test that prompt files are moved to the prompts/ directory."""
from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


class TestPromptsDirectory:
    """Tests for verifying the prompts/ directory structure."""

    def test_prompts_directory_exists(self):
        """Verify prompts/ directory exists."""
        repo_root = get_repo_root()
        prompts_dir = repo_root / "prompts"
        assert prompts_dir.exists(), f"prompts/ directory should exist at {prompts_dir}"
        assert prompts_dir.is_dir(), "prompts/ should be a directory"

    def test_prompt_files_moved_and_renamed(self):
        """Verify all prompt files are moved and renamed (remove 'prompt.' prefix)."""
        repo_root = get_repo_root()
        prompts_dir = repo_root / "prompts"

        expected_files = [
            "issue.ci.md",
            "issue.coverage.md",
            "issue.coverage.fix.md",
            "issue.design.md",
            "issue.implement.md",
            "issue.questions.md",
            "issue.review.md",
            "issue.sonar.md",
            "issue.task.implement.md",
            "issue.task.quality-review.md",
            "issue.task.spec-review.md",
        ]

        for expected_file in expected_files:
            file_path = prompts_dir / expected_file
            assert file_path.exists(), f"Prompt file should exist at {file_path}"
            assert file_path.is_file(), f"{expected_file} should be a file"

    def test_old_prompt_files_removed_from_root(self):
        """Verify old prompt files no longer exist at root."""
        repo_root = get_repo_root()

        old_files = [
            "prompt.issue.ci.md",
            "prompt.issue.coverage.md",
            "prompt.issue.coverage.fix.md",
            "prompt.issue.design.md",
            "prompt.issue.implement.md",
            "prompt.issue.questions.md",
            "prompt.issue.review.md",
            "prompt.issue.sonar.md",
            "prompt.issue.task.implement.md",
            "prompt.issue.task.quality-review.md",
            "prompt.issue.task.spec-review.md",
        ]

        for old_file in old_files:
            file_path = repo_root / old_file
            assert not file_path.exists(), f"Old prompt file should not exist at {file_path}"

    def test_prompts_directory_has_correct_count(self):
        """Verify prompts/ directory has exactly 11 prompt files."""
        repo_root = get_repo_root()
        prompts_dir = repo_root / "prompts"

        prompt_files = list(prompts_dir.glob("*.md"))
        assert len(prompt_files) == 11, f"Expected 11 prompt files, found {len(prompt_files)}: {prompt_files}"
