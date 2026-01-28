"""Configuration handling for the Jeeves SDK Runner."""

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
            enable_tool_logging=enable_tool_logging,
        )

    @classmethod
    def from_env(cls) -> "RunnerConfig":
        raise RuntimeError("from_env is deprecated; use from_args instead.")
