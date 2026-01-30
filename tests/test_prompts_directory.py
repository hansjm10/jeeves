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

    def test_active_workflow_prompts_exist(self):
        """Verify all 11 active workflow prompts exist in prompts/ directory."""
        repo_root = get_repo_root()
        prompts_dir = repo_root / "prompts"

        # These are the 11 active prompts used by default.yaml workflow
        expected_files = [
            "ci.fix.md",
            "design.draft.md",
            "design.edit.md",
            "design.review.md",
            "pr.prepare.md",
            "review.evaluate.md",
            "review.fix.md",
            "task.decompose.md",
            "task.implement.md",
            "task.spec_check.md",
            "verify.completeness.md",
        ]

        for expected_file in expected_files:
            file_path = prompts_dir / expected_file
            assert file_path.exists(), f"Active workflow prompt should exist at {file_path}"
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
        """Verify prompts/ directory has the expected number of prompt files."""
        repo_root = get_repo_root()
        prompts_dir = repo_root / "prompts"

        prompt_files = list(prompts_dir.glob("*.md"))
        # 11 active workflow prompts used by default.yaml
        assert len(prompt_files) == 11, f"Expected 11 prompt files, found {len(prompt_files)}: {prompt_files}"
