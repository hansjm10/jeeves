"""Documentation checks for SDK-only viewer."""

from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent


class TestReadmeDocumentation:
    def test_readme_exists(self):
        readme_path = REPO_ROOT / "README.md"
        assert readme_path.exists(), "README.md should exist at repo root"

    def test_readme_documents_viewer(self):
        content = (REPO_ROOT / "README.md").read_text()
        assert "jeeves.viewer" in content or "viewer" in content, "README.md should document viewer usage"

    def test_readme_documents_prompts_directory(self):
        content = (REPO_ROOT / "README.md").read_text()
        assert "prompts/" in content, "README.md should document prompts/ directory"

    def test_readme_documents_data_dir(self):
        content = (REPO_ROOT / "README.md").read_text()
        assert "JEEVES_DATA_DIR" in content, "README.md should document JEEVES_DATA_DIR"


class TestAgentsMdDocumentation:
    def test_agents_md_exists(self):
        agents_path = REPO_ROOT / "AGENTS.md"
        assert agents_path.exists(), "AGENTS.md should exist at repo root"

    def test_agents_md_documents_viewer(self):
        content = (REPO_ROOT / "AGENTS.md").read_text()
        assert "viewer" in content, "AGENTS.md should document viewer usage"

    def test_agents_md_documents_prompts_directory(self):
        content = (REPO_ROOT / "AGENTS.md").read_text()
        assert "prompts/" in content, "AGENTS.md should document prompts/ directory"
