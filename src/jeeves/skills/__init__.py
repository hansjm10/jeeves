"""
Skill management for phase-based Claude Agent SDK integration.

This module provides:
- SkillManager: Provisions skills based on workflow phase
- SkillRegistry: Configuration for phase-to-skill mappings

The skill management system dynamically provisions Claude Agent SDK skills
based on the current workflow phase. Skills are copied to the target
.claude/skills/ directory before each SDK invocation, enabling the agent
to access context-relevant capabilities.

Example:
    from jeeves.skills import SkillManager

    manager = SkillManager(skills_source=Path("skills/"))
    provisioned = manager.provision_skills(
        target_dir=Path("."),
        phase="design_draft",
        phase_type="execute"
    )
"""

from .manager import SkillManager, SkillRegistry

__all__ = ["SkillManager", "SkillRegistry"]
