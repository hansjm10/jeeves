# tests/skills/test_new_skills_integration.py
"""Integration tests for newly integrated skills from Issue #27.

This module tests that the skills integrated from external sources
(codex-skills, trailofbits/skills, anthropics/skills) are properly
configured and can be provisioned via SkillManager.
"""

import re
from pathlib import Path

import pytest
import yaml

from jeeves.skills.manager import SkillManager

# Root skills directory - relative to project root
SKILLS_DIR = Path(__file__).parent.parent.parent / "skills"


class TestNewSkillsDiscovery:
    """Tests that verify new skills are found by find_skill_path()."""

    @pytest.fixture
    def skill_manager(self) -> SkillManager:
        """Create a SkillManager pointing to the actual skills directory."""
        return SkillManager(skills_source=SKILLS_DIR)

    # --- PR Review Skills (from codex-skills) ---

    def test_find_pr_review_skill(self, skill_manager: SkillManager):
        """pr-review skill is found in review category."""
        path = skill_manager.find_skill_path("pr-review")
        assert path is not None
        assert path == SKILLS_DIR / "review" / "pr-review"
        assert (path / "SKILL.md").exists()

    def test_find_pr_evidence_skill(self, skill_manager: SkillManager):
        """pr-evidence skill is found in review category."""
        path = skill_manager.find_skill_path("pr-evidence")
        assert path is not None
        assert path == SKILLS_DIR / "review" / "pr-evidence"
        assert (path / "SKILL.md").exists()

    def test_find_pr_requirements_skill(self, skill_manager: SkillManager):
        """pr-requirements skill is found in review category."""
        path = skill_manager.find_skill_path("pr-requirements")
        assert path is not None
        assert path == SKILLS_DIR / "review" / "pr-requirements"
        assert (path / "SKILL.md").exists()

    def test_find_pr_audit_skill(self, skill_manager: SkillManager):
        """pr-audit skill is found in review category."""
        path = skill_manager.find_skill_path("pr-audit")
        assert path is not None
        assert path == SKILLS_DIR / "review" / "pr-audit"
        assert (path / "SKILL.md").exists()

    # --- SonarQube Skill (from codex-skills) ---

    def test_find_sonarqube_skill(self, skill_manager: SkillManager):
        """sonarqube skill is found in common category."""
        path = skill_manager.find_skill_path("sonarqube")
        assert path is not None
        assert path == SKILLS_DIR / "common" / "sonarqube"
        assert (path / "SKILL.md").exists()

    # --- Security Review Skill (from trailofbits/skills) ---

    def test_find_differential_review_skill(self, skill_manager: SkillManager):
        """differential-review skill is found in review category."""
        path = skill_manager.find_skill_path("differential-review")
        assert path is not None
        assert path == SKILLS_DIR / "review" / "differential-review"
        assert (path / "SKILL.md").exists()

    # --- Frontend Design Skill (from anthropics/skills) ---

    def test_find_frontend_design_skill(self, skill_manager: SkillManager):
        """frontend-design skill is found in implement category."""
        path = skill_manager.find_skill_path("frontend-design")
        assert path is not None
        assert path == SKILLS_DIR / "implement" / "frontend-design"
        assert (path / "SKILL.md").exists()


class TestNewSkillsPhaseMapping:
    """Tests that verify skills resolve for their mapped phases."""

    @pytest.fixture
    def skill_manager(self) -> SkillManager:
        """Create a SkillManager pointing to the actual skills directory."""
        return SkillManager(skills_source=SKILLS_DIR)

    def test_sonarqube_in_common_skills(self, skill_manager: SkillManager):
        """sonarqube is included in common skills (available to all phases)."""
        # Common skills should be present regardless of phase
        skills = skill_manager.resolve_skills(phase="any_phase", phase_type="execute")
        assert "sonarqube" in skills

    def test_pr_review_skills_for_code_review_phase(self, skill_manager: SkillManager):
        """PR review skills resolve for code_review phase."""
        skills = skill_manager.resolve_skills(phase="code_review", phase_type="evaluate")

        assert "pr-review" in skills
        assert "pr-evidence" in skills
        assert "pr-requirements" in skills
        assert "pr-audit" in skills

    def test_differential_review_for_code_review_phase(self, skill_manager: SkillManager):
        """differential-review resolves for code_review phase."""
        skills = skill_manager.resolve_skills(phase="code_review", phase_type="evaluate")
        assert "differential-review" in skills

    def test_frontend_design_for_implement_task_phase(self, skill_manager: SkillManager):
        """frontend-design resolves for implement_task phase."""
        skills = skill_manager.resolve_skills(phase="implement_task", phase_type="execute")
        assert "frontend-design" in skills


class TestSkillFrontmatterValidation:
    """Tests that verify skill frontmatter is valid and well-formed."""

    # New skills to validate
    NEW_SKILLS = [
        ("review", "pr-review"),
        ("review", "pr-evidence"),
        ("review", "pr-requirements"),
        ("review", "pr-audit"),
        ("common", "sonarqube"),
        ("review", "differential-review"),
        ("implement", "frontend-design"),
    ]

    @pytest.fixture
    def skill_manager(self) -> SkillManager:
        """Create a SkillManager pointing to the actual skills directory."""
        return SkillManager(skills_source=SKILLS_DIR)

    def _parse_frontmatter(self, skill_md_path: Path) -> dict:
        """Parse YAML frontmatter from a SKILL.md file."""
        content = skill_md_path.read_text(encoding="utf-8")

        # Match YAML frontmatter between --- delimiters
        match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
        if not match:
            return {}

        frontmatter_text = match.group(1)
        return yaml.safe_load(frontmatter_text) or {}

    @pytest.mark.parametrize("category,skill_name", NEW_SKILLS)
    def test_skill_has_valid_frontmatter(self, category: str, skill_name: str):
        """Each new skill has valid YAML frontmatter."""
        skill_path = SKILLS_DIR / category / skill_name / "SKILL.md"
        assert skill_path.exists(), f"Skill file not found: {skill_path}"

        frontmatter = self._parse_frontmatter(skill_path)
        assert frontmatter, f"No valid frontmatter found in {skill_path}"

    @pytest.mark.parametrize("category,skill_name", NEW_SKILLS)
    def test_skill_has_name_field(self, category: str, skill_name: str):
        """Each new skill has a 'name' field in frontmatter."""
        skill_path = SKILLS_DIR / category / skill_name / "SKILL.md"
        frontmatter = self._parse_frontmatter(skill_path)

        assert "name" in frontmatter, f"Missing 'name' field in {skill_path}"
        assert frontmatter["name"] == skill_name, (
            f"Name mismatch in {skill_path}: expected '{skill_name}', "
            f"got '{frontmatter['name']}'"
        )

    @pytest.mark.parametrize("category,skill_name", NEW_SKILLS)
    def test_skill_has_description_field(self, category: str, skill_name: str):
        """Each new skill has a 'description' field in frontmatter."""
        skill_path = SKILLS_DIR / category / skill_name / "SKILL.md"
        frontmatter = self._parse_frontmatter(skill_path)

        assert "description" in frontmatter, f"Missing 'description' field in {skill_path}"
        assert len(frontmatter["description"]) > 10, (
            f"Description too short in {skill_path}: '{frontmatter['description']}'"
        )

    @pytest.mark.parametrize("category,skill_name", NEW_SKILLS)
    def test_skill_description_has_triggers(self, category: str, skill_name: str):
        """Each new skill has trigger phrases in description."""
        skill_path = SKILLS_DIR / category / skill_name / "SKILL.md"
        frontmatter = self._parse_frontmatter(skill_path)

        description = frontmatter.get("description", "")
        # Trigger phrases typically contain "Trigger" or describe when to use
        has_trigger_info = (
            "trigger" in description.lower()
            or "use when" in description.lower()
            or "use for" in description.lower()
        )
        assert has_trigger_info, (
            f"Description in {skill_path} should contain trigger phrases or "
            f"'use when/for' guidance"
        )


class TestSkillProvisioning:
    """Tests that verify skills can be provisioned to target directories."""

    @pytest.fixture
    def skill_manager(self) -> SkillManager:
        """Create a SkillManager pointing to the actual skills directory."""
        return SkillManager(skills_source=SKILLS_DIR)

    def test_provision_code_review_skills(
        self, skill_manager: SkillManager, tmp_path: Path
    ):
        """Code review skills are provisioned for code_review phase."""
        provisioned = skill_manager.provision_skills(
            target_dir=tmp_path,
            phase="code_review",
            phase_type="evaluate",
        )

        # Verify PR review skills are provisioned
        assert "pr-review" in provisioned
        assert "pr-evidence" in provisioned
        assert "pr-requirements" in provisioned
        assert "pr-audit" in provisioned
        assert "differential-review" in provisioned

        # Verify files exist in target
        skills_target = tmp_path / ".claude" / "skills"
        assert (skills_target / "pr-review" / "SKILL.md").exists()
        assert (skills_target / "pr-evidence" / "SKILL.md").exists()
        assert (skills_target / "differential-review" / "SKILL.md").exists()

    def test_provision_implement_skills(
        self, skill_manager: SkillManager, tmp_path: Path
    ):
        """Implementation skills are provisioned for implement_task phase."""
        provisioned = skill_manager.provision_skills(
            target_dir=tmp_path,
            phase="implement_task",
            phase_type="execute",
        )

        # Verify frontend-design is provisioned
        assert "frontend-design" in provisioned

        # Verify file exists in target
        skills_target = tmp_path / ".claude" / "skills"
        assert (skills_target / "frontend-design" / "SKILL.md").exists()

    def test_provision_common_skills_all_phases(
        self, skill_manager: SkillManager, tmp_path: Path
    ):
        """Common skills (sonarqube) are provisioned for any phase."""
        # Use a random phase that's not in the registry
        provisioned = skill_manager.provision_skills(
            target_dir=tmp_path,
            phase="arbitrary_phase",
            phase_type="execute",
        )

        # sonarqube should be present as a common skill
        assert "sonarqube" in provisioned

        # Verify file exists in target
        skills_target = tmp_path / ".claude" / "skills"
        assert (skills_target / "sonarqube" / "SKILL.md").exists()


class TestRegistryConfiguration:
    """Tests that verify registry.yaml is properly configured."""

    @pytest.fixture
    def registry_path(self) -> Path:
        """Path to the actual registry.yaml."""
        return SKILLS_DIR / "registry.yaml"

    def test_registry_has_version_1(self, registry_path: Path):
        """Registry has version 1 schema."""
        content = yaml.safe_load(registry_path.read_text())
        assert content.get("version") == 1

    def test_sonarqube_in_common(self, registry_path: Path):
        """sonarqube is listed in common skills."""
        content = yaml.safe_load(registry_path.read_text())
        assert "sonarqube" in content.get("common", [])

    def test_pr_review_skills_in_code_review_phase(self, registry_path: Path):
        """PR review skills are mapped to code_review phase."""
        content = yaml.safe_load(registry_path.read_text())
        code_review_skills = content.get("phases", {}).get("code_review", [])

        assert "pr-review" in code_review_skills
        assert "pr-evidence" in code_review_skills
        assert "pr-requirements" in code_review_skills
        assert "pr-audit" in code_review_skills

    def test_differential_review_in_code_review_phase(self, registry_path: Path):
        """differential-review is mapped to code_review phase."""
        content = yaml.safe_load(registry_path.read_text())
        code_review_skills = content.get("phases", {}).get("code_review", [])

        assert "differential-review" in code_review_skills

    def test_frontend_design_in_implement_task_phase(self, registry_path: Path):
        """frontend-design is mapped to implement_task phase."""
        content = yaml.safe_load(registry_path.read_text())
        implement_skills = content.get("phases", {}).get("implement_task", [])

        assert "frontend-design" in implement_skills
