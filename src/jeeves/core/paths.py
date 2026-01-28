"""XDG-compliant path resolution for Jeeves.

This module provides standardized paths for Jeeves data following XDG Base Directory
Specification via platformdirs.

Directory structure:
    ~/.local/share/jeeves/           # JEEVES_DATA_DIR
    ├── repos/                       # Bare or full clones (shared)
    │   └── {owner}/{repo}/
    ├── worktrees/                   # Git worktrees (one per issue)
    │   └── {owner}/{repo}/issue-{N}/
    ├── issues/                      # Issue state (decoupled from worktree)
    │   └── {owner}/{repo}/{N}/
    │       ├── issue.json
    │       ├── progress.txt
    │       └── .runs/
    └── config.json                  # Global settings
"""

import os
from pathlib import Path
from typing import Optional

try:
    import platformdirs
except ImportError:
    platformdirs = None  # type: ignore


def get_data_dir() -> Path:
    """Get the Jeeves data directory.

    Uses XDG standard paths via platformdirs:
    - Linux: ~/.local/share/jeeves
    - macOS: ~/Library/Application Support/jeeves
    - Windows: ~/AppData/Local/jeeves

    Can be overridden with JEEVES_DATA_DIR environment variable.

    Returns:
        Path to the data directory.
    """
    env_dir = os.environ.get("JEEVES_DATA_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve()

    if platformdirs is not None:
        return Path(platformdirs.user_data_dir("jeeves", appauthor=False))

    # Fallback if platformdirs not installed
    if os.name == "nt":
        # Windows
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        return Path(base) / "jeeves"
    elif os.uname().sysname == "Darwin":
        # macOS
        return Path.home() / "Library" / "Application Support" / "jeeves"
    else:
        # Linux/Unix - XDG_DATA_HOME
        xdg_data = os.environ.get("XDG_DATA_HOME")
        if xdg_data:
            return Path(xdg_data) / "jeeves"
        return Path.home() / ".local" / "share" / "jeeves"


def get_repos_dir() -> Path:
    """Get the directory for repository clones.

    Returns:
        Path to repos directory (~/.local/share/jeeves/repos).
    """
    return get_data_dir() / "repos"


def get_worktrees_dir() -> Path:
    """Get the directory for git worktrees.

    Returns:
        Path to worktrees directory (~/.local/share/jeeves/worktrees).
    """
    return get_data_dir() / "worktrees"


def get_issues_dir() -> Path:
    """Get the directory for issue state files.

    Returns:
        Path to issues directory (~/.local/share/jeeves/issues).
    """
    return get_data_dir() / "issues"


def get_config_file() -> Path:
    """Get the path to the global config file.

    Returns:
        Path to config.json.
    """
    return get_data_dir() / "config.json"


def get_repo_path(owner: str, repo: str) -> Path:
    """Get the path to a specific repository clone.

    Args:
        owner: Repository owner (e.g., 'anthropics').
        repo: Repository name (e.g., 'claude-code').

    Returns:
        Path to the repository directory.
    """
    return get_repos_dir() / owner / repo


def get_worktree_path(owner: str, repo: str, issue_number: int) -> Path:
    """Get the path to a worktree for a specific issue.

    Args:
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.

    Returns:
        Path to the worktree directory.
    """
    return get_worktrees_dir() / owner / repo / f"issue-{issue_number}"


def get_issue_state_dir(owner: str, repo: str, issue_number: int) -> Path:
    """Get the path to the state directory for a specific issue.

    Args:
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.

    Returns:
        Path to the issue state directory.
    """
    return get_issues_dir() / owner / repo / str(issue_number)


def parse_repo_spec(spec: str) -> tuple[str, str]:
    """Parse a repository specification into owner and repo.

    Accepts formats:
    - owner/repo
    - https://github.com/owner/repo
    - https://github.com/owner/repo.git
    - git@github.com:owner/repo.git

    Args:
        spec: Repository specification string.

    Returns:
        Tuple of (owner, repo).

    Raises:
        ValueError: If the spec cannot be parsed.
    """
    spec = spec.strip()

    # Simple owner/repo format
    if "/" in spec and not spec.startswith(("http://", "https://", "git@")):
        parts = spec.split("/")
        if len(parts) == 2:
            owner, repo = parts
            repo = repo.removesuffix(".git")
            if owner and repo:
                return owner, repo

    # HTTPS URL format
    if spec.startswith(("http://", "https://")):
        # Remove protocol and domain
        path = spec.split("github.com/")[-1] if "github.com/" in spec else ""
        path = path.removesuffix(".git").rstrip("/")
        parts = path.split("/")
        if len(parts) >= 2:
            return parts[0], parts[1]

    # SSH format: git@github.com:owner/repo.git
    if spec.startswith("git@"):
        path = spec.split(":")[-1] if ":" in spec else ""
        path = path.removesuffix(".git")
        parts = path.split("/")
        if len(parts) == 2:
            return parts[0], parts[1]

    raise ValueError(
        f"Invalid repository specification: {spec!r}. "
        "Expected format: owner/repo, https://github.com/owner/repo, "
        "or git@github.com:owner/repo.git"
    )


def parse_issue_ref(ref: str) -> tuple[str, str, int]:
    """Parse an issue reference into owner, repo, and issue number.

    Accepts formats:
    - owner/repo#123
    - #123 (requires context repo)
    - https://github.com/owner/repo/issues/123

    Args:
        ref: Issue reference string.

    Returns:
        Tuple of (owner, repo, issue_number).

    Raises:
        ValueError: If the ref cannot be parsed.
    """
    ref = ref.strip()

    # owner/repo#123 format
    if "#" in ref:
        repo_part, issue_part = ref.rsplit("#", 1)
        try:
            issue_number = int(issue_part)
        except ValueError:
            raise ValueError(f"Invalid issue number: {issue_part!r}")

        if "/" in repo_part:
            owner, repo = parse_repo_spec(repo_part)
            return owner, repo, issue_number
        else:
            raise ValueError(
                f"Cannot determine repository from {ref!r}. "
                "Use format: owner/repo#123"
            )

    # GitHub issue URL format
    if "github.com" in ref and "/issues/" in ref:
        # https://github.com/owner/repo/issues/123
        parts = ref.split("/issues/")
        if len(parts) == 2:
            repo_url, issue_str = parts
            try:
                issue_number = int(issue_str.split("/")[0].split("?")[0])
            except ValueError:
                raise ValueError(f"Invalid issue URL: {ref!r}")
            owner, repo = parse_repo_spec(repo_url)
            return owner, repo, issue_number

    # Just a number - try to parse as issue number
    try:
        issue_number = int(ref)
        raise ValueError(
            f"Issue number {issue_number} requires a repository. "
            "Use format: owner/repo#123"
        )
    except ValueError:
        if ref.isdigit():
            raise
        raise ValueError(
            f"Invalid issue reference: {ref!r}. "
            "Expected format: owner/repo#123 or GitHub issue URL"
        )


def ensure_directory(path: Path) -> Path:
    """Ensure a directory exists, creating it if necessary.

    Args:
        path: Path to the directory.

    Returns:
        The path (for chaining).
    """
    path.mkdir(parents=True, exist_ok=True)
    return path


def is_legacy_mode() -> bool:
    """Legacy mode removed; keep for backward compatibility."""
    return False
