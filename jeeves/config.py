"""Global configuration for Jeeves.

This module manages the global Jeeves configuration stored in the data directory.
"""

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, Optional

from .paths import get_config_file, ensure_directory


@dataclass
class GlobalConfig:
    """Global Jeeves configuration.

    Stored in ~/.local/share/jeeves/config.json
    """

    # Default runner to use (sdk, claude, codex)
    default_runner: str = "sdk"

    # Default maximum iterations
    default_max_iterations: int = 10

    # GitHub settings
    github_default_remote: str = "origin"

    # Whether to automatically fetch before creating worktrees
    auto_fetch: bool = True

    # Whether to prune worktrees on cleanup
    prune_worktrees: bool = True

    @classmethod
    def load(cls, path: Optional[Path] = None) -> "GlobalConfig":
        """Load configuration from file.

        Args:
            path: Path to config file. Defaults to standard location.

        Returns:
            GlobalConfig instance.
        """
        if path is None:
            path = get_config_file()

        if not path.exists():
            return cls()

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return cls.from_dict(data)
        except (json.JSONDecodeError, OSError):
            return cls()

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "GlobalConfig":
        """Create config from dictionary.

        Args:
            data: Dictionary with config values.

        Returns:
            GlobalConfig instance.
        """
        return cls(
            default_runner=data.get("default_runner", cls.default_runner),
            default_max_iterations=data.get(
                "default_max_iterations", cls.default_max_iterations
            ),
            github_default_remote=data.get(
                "github_default_remote", cls.github_default_remote
            ),
            auto_fetch=data.get("auto_fetch", cls.auto_fetch),
            prune_worktrees=data.get("prune_worktrees", cls.prune_worktrees),
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary.

        Returns:
            Dictionary representation.
        """
        return asdict(self)

    def save(self, path: Optional[Path] = None) -> None:
        """Save configuration to file.

        Args:
            path: Path to config file. Defaults to standard location.
        """
        if path is None:
            path = get_config_file()

        ensure_directory(path.parent)

        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=2)
            f.write("\n")
