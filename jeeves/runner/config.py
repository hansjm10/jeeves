"""Configuration handling for the Jeeves SDK Runner."""

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class RunnerConfig:
    """Configuration for the SDK runner."""

    # Input/output paths
    prompt_file: Path
    output_file: Path
    text_output_file: Optional[Path] = None

    # Working directories
    work_dir: Path = field(default_factory=Path.cwd)
    state_dir: Optional[Path] = None

    # Agent settings
    allowed_tools: List[str] = field(
        default_factory=lambda: [
            "Read",
            "Write",
            "Edit",
            "Bash",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
        ]
    )
    permission_mode: str = "bypassPermissions"
    max_turns: Optional[int] = None

    # Hooks
    enable_tool_logging: bool = True

    @classmethod
    def from_args(
        cls,
        prompt: str,
        output: str,
        text_output: Optional[str] = None,
        work_dir: Optional[str] = None,
        state_dir: Optional[str] = None,
        allowed_tools: Optional[List[str]] = None,
        permission_mode: Optional[str] = None,
        max_turns: Optional[int] = None,
        enable_tool_logging: bool = True,
    ) -> "RunnerConfig":
        """Create config from command line arguments."""
        return cls(
            prompt_file=Path(prompt),
            output_file=Path(output),
            text_output_file=Path(text_output) if text_output else None,
            work_dir=Path(work_dir) if work_dir else Path.cwd(),
            state_dir=Path(state_dir) if state_dir else None,
            allowed_tools=allowed_tools or cls.__dataclass_fields__["allowed_tools"].default_factory(),
            permission_mode=permission_mode or "bypassPermissions",
            max_turns=max_turns,
            enable_tool_logging=enable_tool_logging,
        )

    @classmethod
    def from_env(cls) -> "RunnerConfig":
        """Create config from environment variables."""
        prompt = os.environ.get("JEEVES_SDK_PROMPT", "")
        output = os.environ.get("JEEVES_SDK_OUTPUT", "sdk-output.json")
        text_output = os.environ.get("JEEVES_SDK_TEXT_OUTPUT")
        work_dir = os.environ.get("JEEVES_WORK_DIR", os.getcwd())
        state_dir = os.environ.get("JEEVES_STATE_DIR")
        max_turns_str = os.environ.get("JEEVES_SDK_MAX_TURNS")
        max_turns = int(max_turns_str) if max_turns_str else None

        return cls(
            prompt_file=Path(prompt) if prompt else Path("prompt.md"),
            output_file=Path(output),
            text_output_file=Path(text_output) if text_output else None,
            work_dir=Path(work_dir),
            state_dir=Path(state_dir) if state_dir else None,
            max_turns=max_turns,
        )
