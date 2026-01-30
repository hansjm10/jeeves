"""Tests for RunnerConfig class."""

from pathlib import Path

import pytest

from jeeves.runner.config import RunnerConfig


class TestRunnerConfigFields:
    """Tests for RunnerConfig field definitions."""

    def test_has_phase_field(self):
        """RunnerConfig has phase: Optional[str] field."""
        config = RunnerConfig(
            prompt_file=Path("prompt.md"),
            output_file=Path("output.json"),
        )
        assert hasattr(config, "phase")
        assert config.phase is None

    def test_has_phase_type_field(self):
        """RunnerConfig has phase_type: Optional[str] field."""
        config = RunnerConfig(
            prompt_file=Path("prompt.md"),
            output_file=Path("output.json"),
        )
        assert hasattr(config, "phase_type")
        assert config.phase_type is None

    def test_has_skills_source_field(self):
        """RunnerConfig has skills_source: Optional[Path] field."""
        config = RunnerConfig(
            prompt_file=Path("prompt.md"),
            output_file=Path("output.json"),
        )
        assert hasattr(config, "skills_source")
        assert config.skills_source is None

    def test_phase_field_accepts_string(self):
        """Phase field accepts string values."""
        config = RunnerConfig(
            prompt_file=Path("prompt.md"),
            output_file=Path("output.json"),
            phase="design_draft",
        )
        assert config.phase == "design_draft"

    def test_phase_type_field_accepts_string(self):
        """Phase type field accepts string values."""
        config = RunnerConfig(
            prompt_file=Path("prompt.md"),
            output_file=Path("output.json"),
            phase_type="execute",
        )
        assert config.phase_type == "execute"

    def test_skills_source_field_accepts_path(self):
        """Skills source field accepts Path values."""
        skills_path = Path("/path/to/skills")
        config = RunnerConfig(
            prompt_file=Path("prompt.md"),
            output_file=Path("output.json"),
            skills_source=skills_path,
        )
        assert config.skills_source == skills_path


class TestRunnerConfigFromArgs:
    """Tests for RunnerConfig.from_args class method."""

    def test_from_args_accepts_phase(self):
        """from_args method accepts phase parameter."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
            phase="implement_task",
        )
        assert config.phase == "implement_task"

    def test_from_args_accepts_phase_type(self):
        """from_args method accepts phase_type parameter."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
            phase_type="evaluate",
        )
        assert config.phase_type == "evaluate"

    def test_from_args_accepts_skills_source(self):
        """from_args method accepts skills_source parameter."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
            skills_source="/path/to/skills",
        )
        assert config.skills_source == Path("/path/to/skills")

    def test_from_args_skills_source_converts_to_path(self):
        """from_args converts skills_source string to Path."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
            skills_source="skills/",
        )
        assert isinstance(config.skills_source, Path)
        assert config.skills_source == Path("skills/")

    def test_from_args_skills_source_none_stays_none(self):
        """from_args keeps skills_source as None if not provided."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
        )
        assert config.skills_source is None

    def test_from_args_all_new_fields(self):
        """from_args accepts all new skill-related fields together."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
            phase="code_review",
            phase_type="execute",
            skills_source="/project/skills",
        )
        assert config.phase == "code_review"
        assert config.phase_type == "execute"
        assert config.skills_source == Path("/project/skills")

    def test_from_args_existing_params_still_work(self):
        """from_args still works with existing parameters."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
            text_output="text.txt",
            work_dir="/work",
            state_dir="/state",
            allowed_tools=["Read", "Write"],
            permission_mode="default",
            enable_tool_logging=False,
        )
        assert config.prompt_file == Path("prompt.md")
        assert config.output_file == Path("output.json")
        assert config.text_output_file == Path("text.txt")
        assert config.work_dir == Path("/work")
        assert config.state_dir == Path("/state")
        assert config.allowed_tools == ["Read", "Write"]
        assert config.permission_mode == "default"
        assert config.enable_tool_logging is False

    def test_from_args_accepts_max_buffer_size(self):
        """from_args accepts max_buffer_size parameter."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
            max_buffer_size=2 * 1024 * 1024,
        )
        assert config.max_buffer_size == 2 * 1024 * 1024


class TestRunnerConfigBackwardCompatibility:
    """Tests ensuring backward compatibility."""

    def test_default_config_still_works(self):
        """Creating config with only required fields still works."""
        config = RunnerConfig(
            prompt_file=Path("prompt.md"),
            output_file=Path("output.json"),
        )
        assert config.prompt_file == Path("prompt.md")
        assert config.output_file == Path("output.json")
        # Verify defaults are applied
        assert config.text_output_file is None
        assert config.state_dir is None
        assert config.permission_mode == "bypassPermissions"
        assert config.enable_tool_logging is True
        # New fields default to None
        assert config.phase is None
        assert config.phase_type is None
        assert config.skills_source is None
        assert config.max_buffer_size == 10 * 1024 * 1024

    def test_from_args_minimal_call_still_works(self):
        """from_args with only required args still works."""
        config = RunnerConfig.from_args(
            prompt="prompt.md",
            output="output.json",
        )
        assert config.prompt_file == Path("prompt.md")
        assert config.output_file == Path("output.json")
