"""
Phase-based skill provisioning for Claude Agent SDK.

The SkillManager resolves which skills apply to a workflow phase and copies
them to the target .claude/skills/ directory before SDK invocation.
"""

import logging
from pathlib import Path
from typing import Dict, List, Optional, Set

import yaml

logger = logging.getLogger(__name__)


class SkillRegistry:
    """
    Parsed skill registry configuration.

    The SkillRegistry holds the configuration for mapping workflow phases to
    skill sets. It is loaded from a YAML file (typically registry.yaml) that
    defines:
    - common: Skills available to all phases
    - phases: Phase-specific skill mappings
    - phase_type_defaults: Fallback skills for unmapped phases by type
    """

    def __init__(
        self,
        version: int,
        common: List[str],
        phases: Dict[str, List[str]],
        phase_type_defaults: Dict[str, List[str]],
    ) -> None:
        """
        Initialize a SkillRegistry.

        Args:
            version: Schema version for future compatibility
            common: List of skill names available to all phases
            phases: Mapping of phase names to lists of skill names
            phase_type_defaults: Mapping of phase types to default skill lists
        """
        self.version = version
        self.common = common
        self.phases = phases
        self.phase_type_defaults = phase_type_defaults

    @classmethod
    def from_yaml(cls, path: Path) -> "SkillRegistry":
        """
        Load registry from YAML file.

        Handles missing files and partial configurations gracefully by using
        empty defaults for any missing sections.

        Args:
            path: Path to the registry.yaml file

        Returns:
            A SkillRegistry instance with the parsed configuration

        Raises:
            FileNotFoundError: If the file does not exist
            yaml.YAMLError: If the file contains invalid YAML
        """
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        # Handle empty file (yaml.safe_load returns None)
        if data is None:
            data = {}

        return cls(
            version=data.get("version", 1),
            common=data.get("common", []),
            phases=data.get("phases", {}),
            phase_type_defaults=data.get("phase_type_defaults", {}),
        )

    @classmethod
    def empty(cls) -> "SkillRegistry":
        """
        Create an empty registry with default values.

        Returns:
            A SkillRegistry instance with empty configuration
        """
        return cls(
            version=1,
            common=[],
            phases={},
            phase_type_defaults={},
        )


class SkillManager:
    """
    Manages dynamic skill provisioning based on workflow phase.

    The SkillManager is responsible for:
    1. Loading the skill registry configuration
    2. Resolving which skills apply to a given phase
    3. Provisioning (copying) skills to the target .claude/skills/ directory

    Example usage:
        manager = SkillManager(skills_source=Path("skills/"))
        skills = manager.resolve_skills(phase="design_draft", phase_type="execute")
        provisioned = manager.provision_skills(
            target_dir=Path("."),
            phase="design_draft",
            phase_type="execute"
        )
    """

    def __init__(
        self,
        skills_source: Path,
        registry_path: Optional[Path] = None,
    ) -> None:
        """
        Initialize the skill manager.

        Args:
            skills_source: Root directory containing skill subdirectories
                          (e.g., jeeves/skills/)
            registry_path: Path to registry.yaml. Defaults to
                          skills_source/registry.yaml
        """
        self.skills_source = skills_source
        self.registry_path = registry_path or (skills_source / "registry.yaml")
        self._registry: Optional[SkillRegistry] = None

    @property
    def registry(self) -> SkillRegistry:
        """
        Lazy-load the registry.

        Returns empty defaults if the registry file doesn't exist.

        Returns:
            The SkillRegistry instance for this manager
        """
        if self._registry is None:
            if self.registry_path.exists():
                self._registry = SkillRegistry.from_yaml(self.registry_path)
            else:
                # Empty registry if file doesn't exist
                self._registry = SkillRegistry.empty()
                logger.warning(f"Registry not found at {self.registry_path}")
        return self._registry

    def resolve_skills(
        self,
        phase: str,
        phase_type: str,
    ) -> Set[str]:
        """
        Resolve the full set of skills for a phase.

        Resolution order (all merged):
        1. Common skills (always included)
        2. Phase-specific skills (exact phase name match)
        3. Phase-type defaults (fallback for unmapped phases)

        Args:
            phase: Phase name (e.g., "design_draft", "implement_task")
            phase_type: Phase type (e.g., "execute", "evaluate")

        Returns:
            Set of skill names to provision
        """
        skills: Set[str] = set()

        # 1. Common skills (always included)
        skills.update(self.registry.common)

        # 2. Phase-specific skills (exact phase name match)
        if phase in self.registry.phases:
            phase_skills = self.registry.phases[phase]
            if phase_skills:  # Handle None or empty list from YAML
                skills.update(phase_skills)
        else:
            # 3. Phase-type defaults (fallback for unmapped phases)
            type_defaults = self.registry.phase_type_defaults.get(phase_type)
            if type_defaults:  # Handle None or empty list from YAML
                skills.update(type_defaults)

        return skills

    def find_skill_path(self, skill_name: str) -> Optional[Path]:
        """
        Find the source path for a skill by name.

        Searches in order:
        1. skills/common/{skill_name}/
        2. skills/design/{skill_name}/
        3. skills/implement/{skill_name}/
        4. skills/review/{skill_name}/
        5. skills/{skill_name}/ (legacy/flat structure)

        Args:
            skill_name: Name of the skill to find

        Returns:
            Path to skill directory, or None if not found
        """
        # Implementation will be added in T4
        raise NotImplementedError("SkillManager.find_skill_path will be implemented in T4")

    def provision_skills(
        self,
        target_dir: Path,
        phase: str,
        phase_type: str,
    ) -> List[str]:
        """
        Provision skills for a phase by copying to target .claude/skills/.

        This method:
        1. Clears any existing skills in target (fresh per iteration)
        2. Resolves which skills apply to the phase
        3. Copies skill directories to target

        Args:
            target_dir: Working directory (contains .claude/)
            phase: Phase name (e.g., "design_draft")
            phase_type: Phase type (e.g., "execute")

        Returns:
            List of successfully provisioned skill names
        """
        # Implementation will be added in T4
        raise NotImplementedError("SkillManager.provision_skills will be implemented in T4")
