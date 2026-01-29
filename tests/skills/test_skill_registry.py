# tests/skills/test_skill_registry.py
"""Tests for SkillRegistry class."""

import pytest
from pathlib import Path
from jeeves.skills.manager import SkillRegistry, SkillManager


class TestSkillRegistry:
    """Tests for SkillRegistry.from_yaml() parsing."""

    def test_load_registry_from_yaml(self, tmp_path: Path):
        """Valid YAML parses correctly with all fields."""
        yaml_content = """
version: 1

common:
  - progress-tracker
  - jeeves

phases:
  design_draft:
    - architecture-patterns
    - api-design
  implement_task:
    - test-driven-dev

phase_type_defaults:
  execute:
    - implementation-best-practices
  evaluate:
    - review-checklist
"""
        registry_file = tmp_path / "registry.yaml"
        registry_file.write_text(yaml_content)

        registry = SkillRegistry.from_yaml(registry_file)

        assert registry.version == 1
        assert registry.common == ["progress-tracker", "jeeves"]
        assert registry.phases["design_draft"] == ["architecture-patterns", "api-design"]
        assert registry.phases["implement_task"] == ["test-driven-dev"]
        assert registry.phase_type_defaults["execute"] == ["implementation-best-practices"]
        assert registry.phase_type_defaults["evaluate"] == ["review-checklist"]

    def test_load_registry_empty_file(self, tmp_path: Path):
        """Empty YAML file returns empty registry with defaults."""
        registry_file = tmp_path / "registry.yaml"
        registry_file.write_text("")

        registry = SkillRegistry.from_yaml(registry_file)

        assert registry.version == 1
        assert registry.common == []
        assert registry.phases == {}
        assert registry.phase_type_defaults == {}

    def test_load_registry_missing_common_section(self, tmp_path: Path):
        """Missing common section returns empty list."""
        yaml_content = """
version: 2

phases:
  design_draft:
    - architecture-patterns
"""
        registry_file = tmp_path / "registry.yaml"
        registry_file.write_text(yaml_content)

        registry = SkillRegistry.from_yaml(registry_file)

        assert registry.version == 2
        assert registry.common == []
        assert registry.phases["design_draft"] == ["architecture-patterns"]
        assert registry.phase_type_defaults == {}

    def test_load_registry_missing_phases_section(self, tmp_path: Path):
        """Missing phases section returns empty dict."""
        yaml_content = """
version: 1

common:
  - progress-tracker

phase_type_defaults:
  execute:
    - implementation-best-practices
"""
        registry_file = tmp_path / "registry.yaml"
        registry_file.write_text(yaml_content)

        registry = SkillRegistry.from_yaml(registry_file)

        assert registry.version == 1
        assert registry.common == ["progress-tracker"]
        assert registry.phases == {}
        assert registry.phase_type_defaults["execute"] == ["implementation-best-practices"]

    def test_load_registry_missing_phase_type_defaults(self, tmp_path: Path):
        """Missing phase_type_defaults section returns empty dict."""
        yaml_content = """
version: 1

common:
  - progress-tracker

phases:
  design_draft:
    - architecture-patterns
"""
        registry_file = tmp_path / "registry.yaml"
        registry_file.write_text(yaml_content)

        registry = SkillRegistry.from_yaml(registry_file)

        assert registry.version == 1
        assert registry.common == ["progress-tracker"]
        assert registry.phases["design_draft"] == ["architecture-patterns"]
        assert registry.phase_type_defaults == {}

    def test_load_registry_missing_version_uses_default(self, tmp_path: Path):
        """Missing version field defaults to 1."""
        yaml_content = """
common:
  - progress-tracker
"""
        registry_file = tmp_path / "registry.yaml"
        registry_file.write_text(yaml_content)

        registry = SkillRegistry.from_yaml(registry_file)

        assert registry.version == 1
        assert registry.common == ["progress-tracker"]

    def test_load_registry_file_not_found(self, tmp_path: Path):
        """Missing file raises FileNotFoundError."""
        registry_file = tmp_path / "nonexistent.yaml"

        with pytest.raises(FileNotFoundError):
            SkillRegistry.from_yaml(registry_file)

    def test_empty_factory_method(self):
        """SkillRegistry.empty() creates default empty registry."""
        registry = SkillRegistry.empty()

        assert registry.version == 1
        assert registry.common == []
        assert registry.phases == {}
        assert registry.phase_type_defaults == {}


class TestSkillManagerRegistry:
    """Tests for SkillManager.registry property."""

    def test_registry_loads_from_file(self, tmp_path: Path):
        """Registry is loaded from file when it exists."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        registry_file = skills_dir / "registry.yaml"
        registry_file.write_text("""
version: 1
common:
  - test-skill
""")

        manager = SkillManager(skills_source=skills_dir)

        assert manager.registry.version == 1
        assert manager.registry.common == ["test-skill"]

    def test_registry_empty_when_file_missing(self, tmp_path: Path):
        """Registry returns empty defaults when file doesn't exist."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        # No registry.yaml created

        manager = SkillManager(skills_source=skills_dir)

        assert manager.registry.version == 1
        assert manager.registry.common == []
        assert manager.registry.phases == {}
        assert manager.registry.phase_type_defaults == {}

    def test_registry_is_cached(self, tmp_path: Path):
        """Registry is lazy-loaded and cached."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        registry_file = skills_dir / "registry.yaml"
        registry_file.write_text("""
version: 1
common:
  - test-skill
""")

        manager = SkillManager(skills_source=skills_dir)

        # Access registry twice
        registry1 = manager.registry
        registry2 = manager.registry

        # Should be the same object (cached)
        assert registry1 is registry2

    def test_custom_registry_path(self, tmp_path: Path):
        """Custom registry path is used when provided."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        custom_registry = tmp_path / "custom-registry.yaml"
        custom_registry.write_text("""
version: 2
common:
  - custom-skill
""")

        manager = SkillManager(
            skills_source=skills_dir,
            registry_path=custom_registry,
        )

        assert manager.registry.version == 2
        assert manager.registry.common == ["custom-skill"]
