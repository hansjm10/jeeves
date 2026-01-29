"""
Phase-based skill provisioning for Claude Agent SDK.

The SkillManager resolves which skills apply to a workflow phase and copies
them to the target .claude/skills/ directory before SDK invocation.
"""

from pathlib import Path
from typing import Dict, List, Optional, Set


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

        Args:
            path: Path to the registry.yaml file

        Returns:
            A SkillRegistry instance with the parsed configuration
        """
        # Implementation will be added in T2
        raise NotImplementedError("SkillRegistry.from_yaml will be implemented in T2")


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

        Returns:
            The SkillRegistry instance for this manager
        """
        # Implementation will be completed in T2
        raise NotImplementedError("SkillManager.registry will be implemented in T2")

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
        # Implementation will be added in T3
        raise NotImplementedError("SkillManager.resolve_skills will be implemented in T3")

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
