"""Jeeves - Autonomous coding agent for GitHub issues.

This package provides tools for managing repository clones, git worktrees,
and issue state for autonomous coding sessions.

Main modules:
    - cli: Command-line interface (jeeves command)
    - paths: XDG-compliant path resolution
    - config: Global configuration
    - repo: Repository cloning and management
    - worktree: Git worktree operations
    - issue: Issue state management
    - runner: SDK-based agent runner
"""

__version__ = "0.1.0"

# Lazy imports to avoid circular dependencies and keep startup fast
def __getattr__(name):
    """Lazy import for top-level exports."""
    if name == "GlobalConfig":
        from .config import GlobalConfig
        return GlobalConfig
    if name == "IssueState":
        from .issue import IssueState
        return IssueState
    if name in ("get_data_dir", "get_repos_dir", "get_worktrees_dir", "get_issues_dir"):
        from . import paths
        return getattr(paths, name)
    if name in ("check_gh_auth_for_browse", "AuthenticationError", "RepoError", "is_gh_authenticated", "list_user_repos", "list_contributed_repos"):
        from . import repo
        return getattr(repo, name)
    if name in ("list_github_issues", "list_assigned_issues", "IssueError"):
        from . import issue
        return getattr(issue, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "__version__",
    "GlobalConfig",
    "IssueState",
    "get_data_dir",
    "get_repos_dir",
    "get_worktrees_dir",
    "get_issues_dir",
    "check_gh_auth_for_browse",
    "AuthenticationError",
    "RepoError",
    "is_gh_authenticated",
    "list_user_repos",
    "list_contributed_repos",
    "list_github_issues",
    "list_assigned_issues",
    "IssueError",
]
