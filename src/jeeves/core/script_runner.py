# src/jeeves/core/script_runner.py
"""Script phase runner for non-AI workflow phases.

Runs shell commands, captures output, and maps results to status updates.
"""

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .workflow import Phase


@dataclass
class ScriptResult:
    """Result of running a script phase."""
    exit_code: int
    output: str
    status_updates: Dict[str, Any]


def _substitute_variables(command: str, context: Dict[str, Any]) -> str:
    """Substitute ${variable} patterns in command string."""
    def replace(match):
        var_name = match.group(1)
        # Support nested access like ${status.field}
        parts = var_name.split(".")
        value = context
        for part in parts:
            if isinstance(value, dict):
                value = value.get(part, "")
            else:
                value = ""
                break
        return str(value)

    return re.sub(r'\$\{([^}]+)\}', replace, command)


def _determine_status_updates(
    exit_code: int,
    output: str,
    status_mapping: Optional[Dict[str, Dict[str, Any]]],
) -> Dict[str, Any]:
    """Determine status updates based on exit code and output."""
    if not status_mapping:
        return {}

    # Check for output-based mapping first (check if output contains key)
    output_lower = output.lower().strip()
    for key, updates in status_mapping.items():
        if key.lower() in output_lower:
            return updates

    # Fall back to exit code mapping
    if exit_code == 0 and "success" in status_mapping:
        return status_mapping["success"]
    if exit_code != 0 and "failure" in status_mapping:
        return status_mapping["failure"]

    return {}


def run_script_phase(
    phase: Phase,
    work_dir: Path,
    context: Dict[str, Any],
    timeout: int = 900,  # 15 minutes default
) -> ScriptResult:
    """Run a script phase.

    Args:
        phase: The script phase to run
        work_dir: Working directory for the script
        context: Context for variable substitution (typically issue.json)
        timeout: Maximum execution time in seconds

    Returns:
        ScriptResult with exit code, output, and status updates
    """
    if not phase.command:
        return ScriptResult(
            exit_code=1,
            output="No command specified for script phase",
            status_updates={},
        )

    # Substitute variables in command
    command = _substitute_variables(phase.command, context)

    # Ensure output directory exists if output_file specified
    output_path = None
    if phase.output_file:
        output_path = work_dir / phase.output_file
        output_path.parent.mkdir(parents=True, exist_ok=True)

    # Run the command
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, **_flatten_context(context)},
        )
        exit_code = result.returncode
        output = result.stdout + result.stderr
    except subprocess.TimeoutExpired as e:
        exit_code = 124  # Standard timeout exit code
        output = f"Command timed out after {timeout}s\n{e.stdout or ''}"
    except Exception as e:
        exit_code = 1
        output = f"Error running command: {e}"

    # Write output to file if specified
    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(output)

    # Determine status updates
    status_updates = _determine_status_updates(
        exit_code,
        output,
        phase.status_mapping,
    )

    return ScriptResult(
        exit_code=exit_code,
        output=output,
        status_updates=status_updates,
    )


def _flatten_context(context: Dict[str, Any], prefix: str = "") -> Dict[str, str]:
    """Flatten nested context dict into environment variables."""
    result = {}
    for key, value in context.items():
        env_key = f"{prefix}{key}".upper().replace(".", "_")
        if isinstance(value, dict):
            result.update(_flatten_context(value, f"{env_key}_"))
        else:
            result[env_key] = str(value) if value is not None else ""
    return result
