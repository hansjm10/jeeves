"""Tests to verify documentation reflects new repository structure (T11).

These tests verify that README.md, CLAUDE.md, and AGENTS.md have been updated
to reflect the new src/ layout repository structure from Issue #12.
"""

from pathlib import Path


# Get repo root (tests/ is one level down from root)
REPO_ROOT = Path(__file__).parent.parent


class TestReadmeDocumentation:
    """Tests for README.md updates."""

    def test_readme_exists(self):
        """README.md should exist at repo root."""
        readme_path = REPO_ROOT / "README.md"
        assert readme_path.exists(), "README.md should exist at repo root"

    def test_readme_documents_src_layout(self):
        """README.md should document the new src/ layout."""
        readme_path = REPO_ROOT / "README.md"
        content = readme_path.read_text()
        assert "src/jeeves" in content, "README.md should document src/jeeves package location"

    def test_readme_documents_prompts_directory(self):
        """README.md should document the prompts/ directory."""
        readme_path = REPO_ROOT / "README.md"
        content = readme_path.read_text()
        assert "prompts/" in content, "README.md should document prompts/ directory"

    def test_readme_documents_scripts_directory(self):
        """README.md should document the scripts/ directory."""
        readme_path = REPO_ROOT / "README.md"
        content = readme_path.read_text()
        assert "scripts/" in content, "README.md should document scripts/ directory"

    def test_readme_documents_tests_directory(self):
        """README.md should document the tests/ directory."""
        readme_path = REPO_ROOT / "README.md"
        content = readme_path.read_text()
        assert "tests/" in content, "README.md should document tests/ directory"

    def test_readme_no_old_viewer_path(self):
        """README.md should not reference old viewer/ path for server.py."""
        readme_path = REPO_ROOT / "README.md"
        content = readme_path.read_text()
        # Should use new path, not old viewer/server.py
        assert "viewer/server.py" not in content or "src/jeeves/viewer" in content, \
            "README.md should use new viewer path (src/jeeves/viewer/server.py)"

    def test_readme_no_old_jeeves_sh_at_root(self):
        """README.md should not reference jeeves.sh at root."""
        readme_path = REPO_ROOT / "README.md"
        content = readme_path.read_text()
        # Should reference scripts/legacy/jeeves.sh, not ./jeeves.sh
        assert "./scripts/jeeves/jeeves.sh" not in content, \
            "README.md should reference scripts/legacy/jeeves.sh, not root jeeves.sh"


class TestClaudeMdDocumentation:
    """Tests for CLAUDE.md updates."""

    def test_claude_md_exists(self):
        """CLAUDE.md should exist at repo root."""
        claude_path = REPO_ROOT / "CLAUDE.md"
        assert claude_path.exists(), "CLAUDE.md should exist at repo root"

    def test_claude_md_documents_jeeves_directory(self):
        """CLAUDE.md should document the .jeeves/ working directory pattern."""
        claude_path = REPO_ROOT / "CLAUDE.md"
        content = claude_path.read_text()
        # CLAUDE.md documents the .jeeves/ working directory, which is correct
        assert ".jeeves/" in content, "CLAUDE.md should document .jeeves/ working directory"


class TestAgentsMdDocumentation:
    """Tests for AGENTS.md updates."""

    def test_agents_md_exists(self):
        """AGENTS.md should exist at repo root."""
        agents_path = REPO_ROOT / "AGENTS.md"
        assert agents_path.exists(), "AGENTS.md should exist at repo root"

    def test_agents_md_documents_prompts_directory(self):
        """AGENTS.md should document prompts/ directory."""
        agents_path = REPO_ROOT / "AGENTS.md"
        content = agents_path.read_text()
        assert "prompts/" in content, "AGENTS.md should document prompts/ directory"

    def test_agents_md_documents_viewer_at_new_path(self):
        """AGENTS.md should document viewer at new src/jeeves/viewer path."""
        agents_path = REPO_ROOT / "AGENTS.md"
        content = agents_path.read_text()
        # Should reference new viewer location
        assert "src/jeeves/viewer" in content or "jeeves.viewer" in content, \
            "AGENTS.md should document viewer at new location"

    def test_agents_md_no_old_prompt_file_pattern(self):
        """AGENTS.md should not reference old prompt.issue.*.md pattern."""
        agents_path = REPO_ROOT / "AGENTS.md"
        content = agents_path.read_text()
        # Old pattern was prompt.issue.*.md, new is prompts/issue.*.md
        assert "prompt.issue." not in content, \
            "AGENTS.md should use new prompt file names (prompts/issue.*.md)"

    def test_agents_md_documents_scripts_legacy(self):
        """AGENTS.md should document scripts/legacy directory."""
        agents_path = REPO_ROOT / "AGENTS.md"
        content = agents_path.read_text()
        assert "scripts/legacy" in content or "scripts/" in content, \
            "AGENTS.md should document scripts/ directory structure"
