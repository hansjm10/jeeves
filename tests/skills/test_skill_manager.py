# tests/skills/test_skill_manager.py
"""Tests for SkillManager methods: resolve_skills, find_skill_path, provision_skills."""

import pytest
from pathlib import Path
from jeeves.skills.manager import SkillManager, SkillRegistry


class TestResolveSkills:
    """Tests for SkillManager.resolve_skills()."""

    def _create_registry(
        self,
        tmp_path: Path,
        common: list[str] | None = None,
        phases: dict[str, list[str]] | None = None,
        phase_type_defaults: dict[str, list[str]] | None = None,
    ) -> SkillManager:
        """Helper to create a SkillManager with a test registry."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir(exist_ok=True)
        registry_file = skills_dir / "registry.yaml"

        yaml_lines = ["version: 1"]

        if common:
            yaml_lines.append("common:")
            for skill in common:
                yaml_lines.append(f"  - {skill}")

        if phases:
            yaml_lines.append("phases:")
            for phase_name, skills in phases.items():
                yaml_lines.append(f"  {phase_name}:")
                for skill in skills:
                    yaml_lines.append(f"    - {skill}")

        if phase_type_defaults:
            yaml_lines.append("phase_type_defaults:")
            for phase_type, skills in phase_type_defaults.items():
                yaml_lines.append(f"  {phase_type}:")
                for skill in skills:
                    yaml_lines.append(f"    - {skill}")

        registry_file.write_text("\n".join(yaml_lines))
        return SkillManager(skills_source=skills_dir)

    def test_resolve_skills_common_only(self, tmp_path: Path):
        """Returns common skills when phase not in registry."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker", "jeeves"],
            phases={},
            phase_type_defaults={},
        )

        skills = manager.resolve_skills(phase="unknown_phase", phase_type="execute")

        assert skills == {"progress-tracker", "jeeves"}

    def test_resolve_skills_phase_specific(self, tmp_path: Path):
        """Returns common + phase-specific skills when phase is mapped."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker"],
            phases={
                "design_draft": ["architecture-patterns", "api-design"],
            },
            phase_type_defaults={},
        )

        skills = manager.resolve_skills(phase="design_draft", phase_type="execute")

        assert skills == {"progress-tracker", "architecture-patterns", "api-design"}

    def test_resolve_skills_phase_type_defaults(self, tmp_path: Path):
        """Falls back to phase_type_defaults when phase not explicitly mapped."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker"],
            phases={},  # No explicit phase mapping
            phase_type_defaults={
                "execute": ["implementation-best-practices"],
                "evaluate": ["review-checklist"],
            },
        )

        skills = manager.resolve_skills(phase="unknown_phase", phase_type="execute")

        assert skills == {"progress-tracker", "implementation-best-practices"}

    def test_resolve_skills_no_duplicates(self, tmp_path: Path):
        """Returns a Set with no duplicates."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker", "shared-skill"],
            phases={
                "design_draft": ["shared-skill", "architecture-patterns"],  # shared-skill is duplicate
            },
            phase_type_defaults={},
        )

        skills = manager.resolve_skills(phase="design_draft", phase_type="execute")

        # Should have no duplicates - 'shared-skill' appears in both common and phase
        assert skills == {"progress-tracker", "shared-skill", "architecture-patterns"}
        assert isinstance(skills, set)
        # Verify it's actually a set with unique items
        assert len(skills) == 3

    def test_resolve_skills_phase_overrides_type_defaults(self, tmp_path: Path):
        """Phase-specific skills are used when phase is mapped, type defaults are NOT added."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker"],
            phases={
                "implement_task": ["test-driven-dev"],
            },
            phase_type_defaults={
                "execute": ["implementation-best-practices"],
            },
        )

        skills = manager.resolve_skills(phase="implement_task", phase_type="execute")

        # Phase-specific skills are used, type defaults are NOT added
        assert skills == {"progress-tracker", "test-driven-dev"}
        assert "implementation-best-practices" not in skills

    def test_resolve_skills_empty_registry(self, tmp_path: Path):
        """Returns empty set when registry is empty."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        registry_file = skills_dir / "registry.yaml"
        registry_file.write_text("")  # Empty file

        manager = SkillManager(skills_source=skills_dir)
        skills = manager.resolve_skills(phase="any_phase", phase_type="execute")

        assert skills == set()

    def test_resolve_skills_common_with_unknown_phase_type(self, tmp_path: Path):
        """Returns only common skills when both phase and phase_type are unknown."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker"],
            phases={
                "design_draft": ["architecture-patterns"],
            },
            phase_type_defaults={
                "execute": ["implementation-best-practices"],
            },
        )

        skills = manager.resolve_skills(phase="unknown_phase", phase_type="unknown_type")

        # Only common skills returned since neither phase nor type is matched
        assert skills == {"progress-tracker"}

    def test_resolve_skills_multiple_phases(self, tmp_path: Path):
        """Different phases return different skill sets."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker"],
            phases={
                "design_draft": ["architecture-patterns"],
                "implement_task": ["test-driven-dev", "error-handling"],
                "code_review": ["security-review", "code-quality"],
            },
            phase_type_defaults={},
        )

        design_skills = manager.resolve_skills(phase="design_draft", phase_type="execute")
        implement_skills = manager.resolve_skills(phase="implement_task", phase_type="execute")
        review_skills = manager.resolve_skills(phase="code_review", phase_type="evaluate")

        assert design_skills == {"progress-tracker", "architecture-patterns"}
        assert implement_skills == {"progress-tracker", "test-driven-dev", "error-handling"}
        assert review_skills == {"progress-tracker", "security-review", "code-quality"}

    def test_resolve_skills_returns_set_type(self, tmp_path: Path):
        """Verify return type is Set[str]."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker"],
            phases={},
            phase_type_defaults={},
        )

        skills = manager.resolve_skills(phase="any_phase", phase_type="execute")

        assert isinstance(skills, set)
        for skill in skills:
            assert isinstance(skill, str)

    def test_resolve_skills_with_no_common_skills(self, tmp_path: Path):
        """Works correctly when there are no common skills defined."""
        manager = self._create_registry(
            tmp_path,
            common=[],  # No common skills
            phases={
                "design_draft": ["architecture-patterns", "api-design"],
            },
            phase_type_defaults={},
        )

        skills = manager.resolve_skills(phase="design_draft", phase_type="execute")

        assert skills == {"architecture-patterns", "api-design"}

    def test_resolve_skills_empty_phase_skills(self, tmp_path: Path):
        """Works correctly when phase has empty skill list."""
        manager = self._create_registry(
            tmp_path,
            common=["progress-tracker"],
            phases={
                "empty_phase": [],  # Phase exists but has no skills
            },
            phase_type_defaults={
                "execute": ["implementation-best-practices"],
            },
        )

        skills = manager.resolve_skills(phase="empty_phase", phase_type="execute")

        # Phase is mapped (even though empty), so type defaults are NOT applied
        assert skills == {"progress-tracker"}


class TestFindSkillPath:
    """Tests for SkillManager.find_skill_path()."""

    def _create_skill(self, skills_dir: Path, category: str | None, skill_name: str) -> Path:
        """Helper to create a skill directory with SKILL.md."""
        if category:
            skill_path = skills_dir / category / skill_name
        else:
            skill_path = skills_dir / skill_name
        skill_path.mkdir(parents=True, exist_ok=True)
        (skill_path / "SKILL.md").write_text(f"---\nname: {skill_name}\n---\n# {skill_name}")
        return skill_path

    def test_find_skill_path_common(self, tmp_path: Path):
        """Finds skill in common directory."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")
        self._create_skill(skills_dir, "common", "progress-tracker")

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("progress-tracker")

        assert path is not None
        assert path == skills_dir / "common" / "progress-tracker"
        assert (path / "SKILL.md").exists()

    def test_find_skill_path_design(self, tmp_path: Path):
        """Finds skill in design category directory."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")
        self._create_skill(skills_dir, "design", "architecture-patterns")

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("architecture-patterns")

        assert path is not None
        assert path == skills_dir / "design" / "architecture-patterns"

    def test_find_skill_path_implement(self, tmp_path: Path):
        """Finds skill in implement category directory."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")
        self._create_skill(skills_dir, "implement", "test-driven-dev")

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("test-driven-dev")

        assert path is not None
        assert path == skills_dir / "implement" / "test-driven-dev"

    def test_find_skill_path_review(self, tmp_path: Path):
        """Finds skill in review category directory."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")
        self._create_skill(skills_dir, "review", "code-quality")

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("code-quality")

        assert path is not None
        assert path == skills_dir / "review" / "code-quality"

    def test_find_skill_path_legacy(self, tmp_path: Path):
        """Finds skill in legacy/flat structure."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")
        self._create_skill(skills_dir, None, "jeeves")  # No category = flat structure

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("jeeves")

        assert path is not None
        assert path == skills_dir / "jeeves"

    def test_find_skill_path_missing(self, tmp_path: Path):
        """Returns None for missing skill."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("nonexistent-skill")

        assert path is None

    def test_find_skill_path_directory_without_skill_md(self, tmp_path: Path):
        """Returns None for directory without SKILL.md."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")
        # Create directory but no SKILL.md
        (skills_dir / "common" / "incomplete-skill").mkdir(parents=True)

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("incomplete-skill")

        assert path is None

    def test_find_skill_path_search_order(self, tmp_path: Path):
        """Searches in correct order: common > design > implement > review > legacy."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "registry.yaml").write_text("version: 1")

        # Create same skill name in multiple locations - common should be found first
        self._create_skill(skills_dir, "common", "multi-location")
        self._create_skill(skills_dir, "design", "multi-location")
        self._create_skill(skills_dir, None, "multi-location")  # legacy

        manager = SkillManager(skills_source=skills_dir)
        path = manager.find_skill_path("multi-location")

        # Should find common first
        assert path == skills_dir / "common" / "multi-location"


class TestProvisionSkills:
    """Tests for SkillManager.provision_skills()."""

    def _create_skill(self, skills_dir: Path, category: str | None, skill_name: str) -> Path:
        """Helper to create a skill directory with SKILL.md."""
        if category:
            skill_path = skills_dir / category / skill_name
        else:
            skill_path = skills_dir / skill_name
        skill_path.mkdir(parents=True, exist_ok=True)
        (skill_path / "SKILL.md").write_text(f"---\nname: {skill_name}\n---\n# {skill_name}")
        return skill_path

    def _create_registry(
        self,
        skills_dir: Path,
        common: list[str] | None = None,
        phases: dict[str, list[str]] | None = None,
        phase_type_defaults: dict[str, list[str]] | None = None,
    ) -> None:
        """Helper to create a registry.yaml file."""
        yaml_lines = ["version: 1"]

        if common:
            yaml_lines.append("common:")
            for skill in common:
                yaml_lines.append(f"  - {skill}")

        if phases:
            yaml_lines.append("phases:")
            for phase_name, skills in phases.items():
                yaml_lines.append(f"  {phase_name}:")
                for skill in skills:
                    yaml_lines.append(f"    - {skill}")

        if phase_type_defaults:
            yaml_lines.append("phase_type_defaults:")
            for phase_type, skills in phase_type_defaults.items():
                yaml_lines.append(f"  {phase_type}:")
                for skill in skills:
                    yaml_lines.append(f"    - {skill}")

        (skills_dir / "registry.yaml").write_text("\n".join(yaml_lines))

    def test_provision_skills_creates_directory(self, tmp_path: Path):
        """Creates .claude/skills/ directory if it doesn't exist."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        self._create_registry(skills_dir, common=["progress-tracker"])
        self._create_skill(skills_dir, "common", "progress-tracker")

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        manager = SkillManager(skills_source=skills_dir)
        manager.provision_skills(target_dir=target_dir, phase="any", phase_type="execute")

        assert (target_dir / ".claude" / "skills").exists()
        assert (target_dir / ".claude" / "skills").is_dir()

    def test_provision_skills_clears_existing(self, tmp_path: Path):
        """Clears existing .claude/skills/ contents before provisioning."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        self._create_registry(skills_dir, common=["new-skill"])
        self._create_skill(skills_dir, "common", "new-skill")

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        # Pre-create a skill in target
        existing_skill_dir = target_dir / ".claude" / "skills" / "old-skill"
        existing_skill_dir.mkdir(parents=True)
        (existing_skill_dir / "SKILL.md").write_text("old content")

        manager = SkillManager(skills_source=skills_dir)
        manager.provision_skills(target_dir=target_dir, phase="any", phase_type="execute")

        # Old skill should be gone
        assert not (target_dir / ".claude" / "skills" / "old-skill").exists()
        # New skill should be present
        assert (target_dir / ".claude" / "skills" / "new-skill").exists()

    def test_provision_skills_copies_skills(self, tmp_path: Path):
        """Copies skill directories from source to target."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        self._create_registry(
            skills_dir,
            common=["progress-tracker"],
            phases={"design_draft": ["architecture-patterns"]},
        )
        self._create_skill(skills_dir, "common", "progress-tracker")
        self._create_skill(skills_dir, "design", "architecture-patterns")

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        manager = SkillManager(skills_source=skills_dir)
        manager.provision_skills(target_dir=target_dir, phase="design_draft", phase_type="execute")

        # Both skills should be copied
        assert (target_dir / ".claude" / "skills" / "progress-tracker").exists()
        assert (target_dir / ".claude" / "skills" / "progress-tracker" / "SKILL.md").exists()
        assert (target_dir / ".claude" / "skills" / "architecture-patterns").exists()
        assert (target_dir / ".claude" / "skills" / "architecture-patterns" / "SKILL.md").exists()

    def test_provision_skills_returns_list(self, tmp_path: Path):
        """Returns list of successfully provisioned skill names."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        self._create_registry(
            skills_dir,
            common=["progress-tracker", "jeeves"],
            phases={"design_draft": ["architecture-patterns"]},
        )
        self._create_skill(skills_dir, "common", "progress-tracker")
        self._create_skill(skills_dir, None, "jeeves")  # legacy
        self._create_skill(skills_dir, "design", "architecture-patterns")

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        manager = SkillManager(skills_source=skills_dir)
        provisioned = manager.provision_skills(
            target_dir=target_dir, phase="design_draft", phase_type="execute"
        )

        # Should return all provisioned skills
        assert isinstance(provisioned, list)
        assert set(provisioned) == {"progress-tracker", "jeeves", "architecture-patterns"}

    def test_provision_skills_skips_missing_skills(self, tmp_path: Path):
        """Skips skills that cannot be found (with warning logged)."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        self._create_registry(
            skills_dir,
            common=["existing-skill", "missing-skill"],  # missing-skill doesn't exist
        )
        self._create_skill(skills_dir, "common", "existing-skill")
        # Intentionally NOT creating missing-skill

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        manager = SkillManager(skills_source=skills_dir)
        provisioned = manager.provision_skills(
            target_dir=target_dir, phase="any", phase_type="execute"
        )

        # Only existing skill should be provisioned
        assert provisioned == ["existing-skill"]
        assert (target_dir / ".claude" / "skills" / "existing-skill").exists()
        assert not (target_dir / ".claude" / "skills" / "missing-skill").exists()

    def test_provision_skills_integration(self, tmp_path: Path):
        """Integration test: skills appear in target directory for a realistic scenario."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        # Set up a realistic registry
        self._create_registry(
            skills_dir,
            common=["progress-tracker"],
            phases={
                "design_draft": ["architecture-patterns", "api-design"],
                "implement_task": ["test-driven-dev"],
            },
            phase_type_defaults={
                "execute": ["implementation-best-practices"],
            },
        )

        # Create all skills
        self._create_skill(skills_dir, "common", "progress-tracker")
        self._create_skill(skills_dir, "design", "architecture-patterns")
        self._create_skill(skills_dir, "design", "api-design")
        self._create_skill(skills_dir, "implement", "test-driven-dev")
        self._create_skill(skills_dir, "implement", "implementation-best-practices")

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        manager = SkillManager(skills_source=skills_dir)

        # Provision for design_draft phase
        provisioned = manager.provision_skills(
            target_dir=target_dir, phase="design_draft", phase_type="execute"
        )

        # Verify correct skills provisioned
        assert set(provisioned) == {"progress-tracker", "architecture-patterns", "api-design"}

        # Verify files exist in target
        skills_target = target_dir / ".claude" / "skills"
        assert (skills_target / "progress-tracker" / "SKILL.md").exists()
        assert (skills_target / "architecture-patterns" / "SKILL.md").exists()
        assert (skills_target / "api-design" / "SKILL.md").exists()

        # Verify implementation skills NOT present (different phase)
        assert not (skills_target / "test-driven-dev").exists()
        assert not (skills_target / "implementation-best-practices").exists()

    def test_provision_skills_phase_type_fallback(self, tmp_path: Path):
        """Falls back to phase_type_defaults for unmapped phases."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        self._create_registry(
            skills_dir,
            common=["progress-tracker"],
            phases={},  # No phase-specific mappings
            phase_type_defaults={
                "execute": ["implementation-best-practices"],
            },
        )
        self._create_skill(skills_dir, "common", "progress-tracker")
        self._create_skill(skills_dir, "implement", "implementation-best-practices")

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        manager = SkillManager(skills_source=skills_dir)
        provisioned = manager.provision_skills(
            target_dir=target_dir, phase="unknown_phase", phase_type="execute"
        )

        # Should fall back to phase_type_defaults
        assert set(provisioned) == {"progress-tracker", "implementation-best-practices"}

    def test_provision_skills_empty_result(self, tmp_path: Path):
        """Returns empty list when no skills are resolved."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        self._create_registry(skills_dir)  # Empty registry

        target_dir = tmp_path / "target"
        target_dir.mkdir()

        manager = SkillManager(skills_source=skills_dir)
        provisioned = manager.provision_skills(
            target_dir=target_dir, phase="any", phase_type="execute"
        )

        assert provisioned == []
        assert (target_dir / ".claude" / "skills").exists()  # Directory still created
