# src/jeeves/core/engine.py
"""Workflow engine for evaluating and transitioning between phases.

The engine is stateless - it evaluates transitions based on the current
phase and context (issue.json), returning the next phase if a transition
should occur.
"""

from typing import Any, Dict, Optional

from .workflow import Workflow, Phase, PhaseType
from .guards import evaluate_guard


class WorkflowEngine:
    """Engine for evaluating workflow transitions.

    The engine does not manage state directly - it only evaluates
    which transition (if any) should be taken given the current
    phase and context.
    """

    def __init__(self, workflow: Workflow):
        self.workflow = workflow

    def get_phase(self, phase_name: str) -> Optional[Phase]:
        """Get a phase by name."""
        return self.workflow.get_phase(phase_name)

    def get_start_phase(self) -> Phase:
        """Get the starting phase of the workflow."""
        return self.workflow.get_start_phase()

    def is_terminal(self, phase_name: str) -> bool:
        """Check if a phase is a terminal state."""
        phase = self.get_phase(phase_name)
        return phase is not None and phase.type == PhaseType.TERMINAL

    def evaluate_transitions(
        self,
        current_phase: str,
        context: Dict[str, Any],
    ) -> Optional[str]:
        """Evaluate transitions and return the next phase if any.

        Args:
            current_phase: Name of the current phase
            context: Evaluation context (typically issue.json contents)

        Returns:
            Name of the next phase, or None if no transition should occur
        """
        phase = self.get_phase(current_phase)
        if phase is None:
            return None

        # Terminal phases have no transitions
        if phase.type == PhaseType.TERMINAL:
            return None

        # Evaluate transitions in priority order (already sorted)
        for transition in phase.transitions:
            # Auto transitions always fire
            if transition.auto:
                return transition.to

            # Evaluate guard expression
            if transition.when and evaluate_guard(transition.when, context):
                return transition.to

        # No transition matched
        return None

    def get_prompt_for_phase(self, phase_name: str) -> Optional[str]:
        """Get the prompt file name for a phase."""
        phase = self.get_phase(phase_name)
        if phase is None:
            return None
        return phase.prompt

    def get_phase_type(self, phase_name: str) -> Optional[PhaseType]:
        """Get the type of a phase."""
        phase = self.get_phase(phase_name)
        if phase is None:
            return None
        return phase.type
