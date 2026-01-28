# tests/test_script_runner.py
import pytest
from pathlib import Path
from jeeves.core.script_runner import run_script_phase, ScriptResult
from jeeves.core.workflow import Phase, PhaseType


class TestScriptRunner:
    def test_run_simple_command(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo success",
            status_mapping={
                "success": {"passed": True},
            },
        )

        result = run_script_phase(phase, tmp_path, {})

        assert result.exit_code == 0
        assert result.output.strip() == "success"
        assert result.status_updates == {"passed": True}

    def test_run_command_with_variable_substitution(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo ${branch}",
        )
        context = {"branch": "issue/123"}

        result = run_script_phase(phase, tmp_path, context)

        assert result.output.strip() == "issue/123"

    def test_run_command_failure(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="exit 1",
            status_mapping={
                "failure": {"failed": True},
            },
        )

        result = run_script_phase(phase, tmp_path, {})

        assert result.exit_code == 1
        assert result.status_updates == {"failed": True}

    def test_output_file_written(self, tmp_path):
        output_file = ".jeeves/script-output.txt"
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo 'line1' && echo 'line2'",
            output_file=output_file,
        )

        result = run_script_phase(phase, tmp_path, {})

        output_path = tmp_path / output_file
        assert output_path.exists()
        assert "line1" in output_path.read_text()

    def test_status_mapping_by_output(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo 'success'",
            status_mapping={
                "success": {"ciPassed": True},
                "failure": {"ciFailed": True},
            },
        )

        result = run_script_phase(phase, tmp_path, {})

        assert result.status_updates == {"ciPassed": True}

    def test_no_command_returns_error(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command=None,
        )

        result = run_script_phase(phase, tmp_path, {})

        assert result.exit_code == 1
        assert "No command specified" in result.output
        assert result.status_updates == {}

    def test_nested_variable_substitution(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo ${status.phase}",
        )
        context = {"status": {"phase": "review"}}

        result = run_script_phase(phase, tmp_path, context)

        assert result.output.strip() == "review"

    def test_missing_variable_substitutes_empty_string(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo 'before ${nonexistent} after'",
        )

        result = run_script_phase(phase, tmp_path, {})

        assert "before" in result.output
        assert "after" in result.output

    def test_context_available_as_env_vars(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="echo $STATUS_PHASE",
        )
        context = {"status": {"phase": "review"}}

        result = run_script_phase(phase, tmp_path, context)

        assert result.output.strip() == "review"

    def test_timeout_handling(self, tmp_path):
        phase = Phase(
            name="test",
            type=PhaseType.SCRIPT,
            command="sleep 10",
        )

        result = run_script_phase(phase, tmp_path, {}, timeout=1)

        assert result.exit_code == 124
        assert "timed out" in result.output.lower()
