"""Core modules for Jeeves.

This package contains the core functionality:
    - config: Global configuration management
    - paths: XDG-compliant path resolution
    - repo: Repository cloning and management
    - worktree: Git worktree operations
    - issue: Issue state management
    - browse: Interactive repository and issue browsing
    - guards: Guard expression parser for workflow transitions
"""

from . import browse
from . import config
from . import guards
from . import issue
from . import paths
from . import repo
from . import worktree

__all__ = [
    "browse",
    "config",
    "guards",
    "issue",
    "paths",
    "repo",
    "worktree",
]
