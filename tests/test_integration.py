# tests/test_integration.py
"""Integration tests for model configuration flow.

These tests verify that model configuration flows correctly from YAML
through workflow loading to the get_effective_model() method.
"""

import pytest
import tempfile
from pathlib import Path

from jeeves.core.workflow_loader import load_workflow
from jeeves.core.workflow import Workflow, Phase, PhaseType


class TestModelFlowIntegration:
    """Integration tests for model configuration flow from YAML to get_effective_model."""

    def test_model_from_yaml_accessible_via_phases(self, tmp_path):
        """Test model from YAML is accessible via workflow.phases[name].model."""
        # Create a workflow YAML with model configuration
        workflow_yaml = tmp_path / "test_workflow.yaml"
        workflow_yaml.write_text("""
workflow:
  name: test
  version: 1
  start: design

phases:
  design:
    type: execute
    prompt: design.md
    model: opus
  review:
    type: evaluate
    prompt: review.md
    model: haiku
  complete:
    type: terminal
""")

        # Load the workflow
        workflow = load_workflow(workflow_yaml)

        # Verify model is accessible via workflow.phases[name].model
        assert workflow.phases["design"].model == "opus"
        assert workflow.phases["review"].model == "haiku"
        assert workflow.phases["complete"].model is None

    def test_get_effective_model_returns_phase_model_when_set(self, tmp_path):
        """Test get_effective_model returns phase model when set."""
        # Create workflow with both workflow default and phase-specific models
        workflow_yaml = tmp_path / "test_workflow.yaml"
        workflow_yaml.write_text("""
workflow:
  name: test
  version: 1
  start: design
  default_model: sonnet

phases:
  design:
    type: execute
    prompt: design.md
    model: opus
  complete:
    type: terminal
""")

        workflow = load_workflow(workflow_yaml)

        # Phase model should override workflow default
        assert workflow.get_effective_model("design") == "opus"

    def test_get_effective_model_returns_workflow_default_when_phase_model_not_set(self, tmp_path):
        """Test get_effective_model returns workflow default when phase model not set."""
        # Create workflow with default_model but phase without model
        workflow_yaml = tmp_path / "test_workflow.yaml"
        workflow_yaml.write_text("""
workflow:
  name: test
  version: 1
  start: design
  default_model: haiku

phases:
  design:
    type: execute
    prompt: design.md
  complete:
    type: terminal
""")

        workflow = load_workflow(workflow_yaml)

        # Phase has no model, should use workflow default
        assert workflow.phases["design"].model is None
        assert workflow.get_effective_model("design") == "haiku"

    def test_get_effective_model_returns_none_when_neither_set(self, tmp_path):
        """Test get_effective_model returns None when neither set."""
        # Create workflow without any model configuration
        workflow_yaml = tmp_path / "test_workflow.yaml"
        workflow_yaml.write_text("""
workflow:
  name: test
  version: 1
  start: design

phases:
  design:
    type: execute
    prompt: design.md
  complete:
    type: terminal
""")

        workflow = load_workflow(workflow_yaml)

        # No model anywhere, should return None
        assert workflow.default_model is None
        assert workflow.phases["design"].model is None
        assert workflow.get_effective_model("design") is None

    def test_model_inheritance_hierarchy(self, tmp_path):
        """Test complete model inheritance hierarchy from YAML through get_effective_model."""
        # Create workflow with mixed model configurations
        workflow_yaml = tmp_path / "test_workflow.yaml"
        workflow_yaml.write_text("""
workflow:
  name: test
  version: 1
  start: phase1
  default_model: sonnet

phases:
  phase1:
    type: execute
    prompt: phase1.md
    model: opus
  phase2:
    type: execute
    prompt: phase2.md
  phase3:
    type: terminal
""")

        workflow = load_workflow(workflow_yaml)

        # Verify the complete hierarchy:
        # 1. Phase with model set -> returns phase model
        assert workflow.get_effective_model("phase1") == "opus"

        # 2. Phase without model but workflow has default -> returns workflow default
        assert workflow.get_effective_model("phase2") == "sonnet"

        # 3. Terminal phase without model, workflow has default -> returns workflow default
        assert workflow.get_effective_model("phase3") == "sonnet"

        # 4. Non-existent phase -> returns None
        assert workflow.get_effective_model("nonexistent") is None

    def test_all_valid_models_load_from_yaml(self, tmp_path):
        """Test all valid model values (sonnet, opus, haiku) load correctly from YAML."""
        workflow_yaml = tmp_path / "test_workflow.yaml"
        workflow_yaml.write_text("""
workflow:
  name: test
  version: 1
  start: phase_sonnet
  default_model: haiku

phases:
  phase_sonnet:
    type: execute
    prompt: p.md
    model: sonnet
    transitions:
      - to: phase_opus
        auto: true
  phase_opus:
    type: execute
    prompt: p.md
    model: opus
    transitions:
      - to: phase_haiku
        auto: true
  phase_haiku:
    type: execute
    prompt: p.md
    model: haiku
    transitions:
      - to: complete
        auto: true
  complete:
    type: terminal
""")

        workflow = load_workflow(workflow_yaml)

        # Verify all models load correctly
        assert workflow.phases["phase_sonnet"].model == "sonnet"
        assert workflow.phases["phase_opus"].model == "opus"
        assert workflow.phases["phase_haiku"].model == "haiku"
        assert workflow.default_model == "haiku"

        # Verify get_effective_model for each
        assert workflow.get_effective_model("phase_sonnet") == "sonnet"
        assert workflow.get_effective_model("phase_opus") == "opus"
        assert workflow.get_effective_model("phase_haiku") == "haiku"
        assert workflow.get_effective_model("complete") == "haiku"  # Uses default
