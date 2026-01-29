# tests/skills/test_skill_manager.py
"""Tests for SkillManager.resolve_skills() method."""

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
