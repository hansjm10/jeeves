# tests/skills/test_skill_integration.py
"""Integration tests for skill provisioning in SDKRunner."""

import pytest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from jeeves.runner.config import RunnerConfig
from jeeves.runner.sdk_runner import SDKRunner
from jeeves.skills.manager import SkillManager


class TestSDKRunnerSkillIntegration:
    """Integration tests for SDKRunner skill provisioning."""

    def _create_test_config(
        self,
        tmp_path: Path,
        phase: str | None = None,
        phase_type: str | None = None,
        skills_source: Path | None = None,
    ) -> RunnerConfig:
        """Create a test RunnerConfig."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("Test prompt")

        output_file = tmp_path / "output.json"
        text_output_file = tmp_path / "output.txt"

        return RunnerConfig(
            prompt_file=prompt_file,
            output_file=output_file,
            text_output_file=text_output_file,
            work_dir=tmp_path,
            phase=phase,
            phase_type=phase_type,
            skills_source=skills_source,
            allowed_tools=["Read", "Write"],
        )

    def _setup_skills(self, tmp_path: Path) -> Path:
        """Set up a test skills directory with registry and skills."""
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()

        # Create registry.yaml
        registry = skills_dir / "registry.yaml"
        registry.write_text(
            """version: 1
common:
  - progress-tracker
phases:
  design_draft:
    - architecture-patterns
  implement_task:
    - test-driven-dev
phase_type_defaults:
  execute:
    - best-practices
"""
        )

        # Create common skill
        common_skill = skills_dir / "common" / "progress-tracker"
        common_skill.mkdir(parents=True)
        (common_skill / "SKILL.md").write_text("# Progress Tracker\nTrack progress.")

        # Create design skill
        design_skill = skills_dir / "design" / "architecture-patterns"
        design_skill.mkdir(parents=True)
        (design_skill / "SKILL.md").write_text("# Architecture Patterns\nDesign patterns.")

        # Create implement skill
        implement_skill = skills_dir / "implement" / "test-driven-dev"
        implement_skill.mkdir(parents=True)
        (implement_skill / "SKILL.md").write_text("# Test-Driven Dev\nTDD practices.")

        # Create phase type default skill
        implement_best = skills_dir / "implement" / "best-practices"
        implement_best.mkdir(parents=True)
        (implement_best / "SKILL.md").write_text("# Best Practices\nGeneral best practices.")

        return skills_dir

    def test_sdk_runner_initializes_skill_manager(self, tmp_path: Path):
        """SDKRunner initializes SkillManager when skills_source is configured."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase="design_draft",
            phase_type="execute",
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)

        assert runner._skill_manager is not None
        assert isinstance(runner._skill_manager, SkillManager)
        assert runner._skill_manager.skills_source == skills_dir

    def test_sdk_runner_no_skill_manager_without_skills_source(self, tmp_path: Path):
        """SDKRunner does not initialize SkillManager without skills_source."""
        config = self._create_test_config(
            tmp_path,
            phase="design_draft",
            phase_type="execute",
            skills_source=None,
        )

        runner = SDKRunner(config)

        assert runner._skill_manager is None

    @pytest.mark.asyncio
    async def test_provision_skills_called_before_query(self, tmp_path: Path):
        """provision_skills is called before query() when phase and phase_type are set."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase="design_draft",
            phase_type="execute",
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)

        # Mock the query function to avoid actual SDK calls
        with patch("jeeves.runner.sdk_runner.query") as mock_query:
            # Make query an async iterator that returns empty
            mock_query.return_value = AsyncMock()
            mock_query.return_value.__aiter__ = lambda self: self
            mock_query.return_value.__anext__ = AsyncMock(side_effect=StopAsyncIteration)

            await runner.run()

        # Verify skills were provisioned to target directory
        target_skills_dir = tmp_path / ".claude" / "skills"
        assert target_skills_dir.exists()
        assert (target_skills_dir / "progress-tracker" / "SKILL.md").exists()
        assert (target_skills_dir / "architecture-patterns" / "SKILL.md").exists()

    @pytest.mark.asyncio
    async def test_skill_tool_added_to_allowed_tools(self, tmp_path: Path):
        """Skill tool added to allowed_tools when skills are provisioned."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase="design_draft",
            phase_type="execute",
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)
        captured_options = None

        # Mock the query function to capture the options
        with patch("jeeves.runner.sdk_runner.query") as mock_query:

            def capture_query(*args, **kwargs):
                nonlocal captured_options
                captured_options = kwargs.get("options")
                # Return an async iterator
                mock = AsyncMock()
                mock.__aiter__ = lambda self: self
                mock.__anext__ = AsyncMock(side_effect=StopAsyncIteration)
                return mock

            mock_query.side_effect = capture_query

            await runner.run()

        # Verify Skill is in allowed_tools
        assert captured_options is not None
        assert "Skill" in captured_options.allowed_tools

    @pytest.mark.asyncio
    async def test_setting_sources_project_when_skills_provisioned(self, tmp_path: Path):
        """setting_sources=['project'] passed to ClaudeAgentOptions when skills provisioned."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase="design_draft",
            phase_type="execute",
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)
        captured_options = None

        # Mock the query function to capture the options
        with patch("jeeves.runner.sdk_runner.query") as mock_query:

            def capture_query(*args, **kwargs):
                nonlocal captured_options
                captured_options = kwargs.get("options")
                # Return an async iterator
                mock = AsyncMock()
                mock.__aiter__ = lambda self: self
                mock.__anext__ = AsyncMock(side_effect=StopAsyncIteration)
                return mock

            mock_query.side_effect = capture_query

            await runner.run()

        # Verify setting_sources is set to ["project"]
        assert captured_options is not None
        assert captured_options.setting_sources == ["project"]

    @pytest.mark.asyncio
    async def test_no_setting_sources_without_skills(self, tmp_path: Path):
        """setting_sources is None when no skills are provisioned."""
        config = self._create_test_config(
            tmp_path,
            phase=None,
            phase_type=None,
            skills_source=None,
        )

        runner = SDKRunner(config)
        captured_options = None

        # Mock the query function to capture the options
        with patch("jeeves.runner.sdk_runner.query") as mock_query:

            def capture_query(*args, **kwargs):
                nonlocal captured_options
                captured_options = kwargs.get("options")
                # Return an async iterator
                mock = AsyncMock()
                mock.__aiter__ = lambda self: self
                mock.__anext__ = AsyncMock(side_effect=StopAsyncIteration)
                return mock

            mock_query.side_effect = capture_query

            await runner.run()

        # Verify setting_sources is None
        assert captured_options is not None
        assert captured_options.setting_sources is None

    @pytest.mark.asyncio
    async def test_logs_provisioned_skills(self, tmp_path: Path):
        """Logs provisioned skills to text output."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase="design_draft",
            phase_type="execute",
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)

        # Mock the query function
        with patch("jeeves.runner.sdk_runner.query") as mock_query:
            mock = AsyncMock()
            mock.__aiter__ = lambda self: self
            mock.__anext__ = AsyncMock(side_effect=StopAsyncIteration)
            mock_query.return_value = mock

            await runner.run()

        # Verify log file contains skills info
        log_content = config.text_output_file.read_text()
        assert "[SKILLS] Provisioned for design_draft:" in log_content
        assert "progress-tracker" in log_content
        assert "architecture-patterns" in log_content

    @pytest.mark.asyncio
    async def test_integration_end_to_end(self, tmp_path: Path):
        """Integration test verifies end-to-end skill provisioning."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase="implement_task",
            phase_type="execute",
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)
        captured_options = None

        # Mock the query function
        with patch("jeeves.runner.sdk_runner.query") as mock_query:

            def capture_query(*args, **kwargs):
                nonlocal captured_options
                captured_options = kwargs.get("options")
                mock = AsyncMock()
                mock.__aiter__ = lambda self: self
                mock.__anext__ = AsyncMock(side_effect=StopAsyncIteration)
                return mock

            mock_query.side_effect = capture_query

            await runner.run()

        # 1. Verify SkillManager was initialized
        assert runner._skill_manager is not None

        # 2. Verify skills were provisioned
        target_skills_dir = tmp_path / ".claude" / "skills"
        assert target_skills_dir.exists()
        assert (target_skills_dir / "progress-tracker").exists()
        assert (target_skills_dir / "test-driven-dev").exists()

        # 3. Verify Skill tool is in allowed_tools
        assert "Skill" in captured_options.allowed_tools

        # 4. Verify setting_sources
        assert captured_options.setting_sources == ["project"]

        # 5. Verify log output
        log_content = config.text_output_file.read_text()
        assert "[SKILLS]" in log_content

    @pytest.mark.asyncio
    async def test_no_provision_without_phase(self, tmp_path: Path):
        """Skills are not provisioned when phase is not set."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase=None,  # No phase
            phase_type="execute",
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)
        captured_options = None

        with patch("jeeves.runner.sdk_runner.query") as mock_query:

            def capture_query(*args, **kwargs):
                nonlocal captured_options
                captured_options = kwargs.get("options")
                mock = AsyncMock()
                mock.__aiter__ = lambda self: self
                mock.__anext__ = AsyncMock(side_effect=StopAsyncIteration)
                return mock

            mock_query.side_effect = capture_query

            await runner.run()

        # Verify no skills directory was created
        target_skills_dir = tmp_path / ".claude" / "skills"
        assert not target_skills_dir.exists()

        # Verify Skill not in allowed_tools
        assert "Skill" not in captured_options.allowed_tools

    @pytest.mark.asyncio
    async def test_no_provision_without_phase_type(self, tmp_path: Path):
        """Skills are not provisioned when phase_type is not set."""
        skills_dir = self._setup_skills(tmp_path)
        config = self._create_test_config(
            tmp_path,
            phase="design_draft",
            phase_type=None,  # No phase_type
            skills_source=skills_dir,
        )

        runner = SDKRunner(config)
        captured_options = None

        with patch("jeeves.runner.sdk_runner.query") as mock_query:

            def capture_query(*args, **kwargs):
                nonlocal captured_options
                captured_options = kwargs.get("options")
                mock = AsyncMock()
                mock.__aiter__ = lambda self: self
                mock.__anext__ = AsyncMock(side_effect=StopAsyncIteration)
                return mock

            mock_query.side_effect = capture_query

            await runner.run()

        # Verify no skills directory was created
        target_skills_dir = tmp_path / ".claude" / "skills"
        assert not target_skills_dir.exists()

        # Verify Skill not in allowed_tools
        assert "Skill" not in captured_options.allowed_tools
