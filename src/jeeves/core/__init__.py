"""Core modules for Jeeves.

This package contains the core functionality:
    - config: Global configuration management
    - paths: XDG-compliant path resolution
    - repo: Repository cloning and management
    - worktree: Git worktree operations
    - issue: Issue state management
    - browse: Interactive repository and issue browsing
"""

from . import browse
from . import config
from . import issue
from . import paths
from . import repo
from . import worktree

__all__ = [
    "browse",
    "config",
    "issue",
    "paths",
    "repo",
    "worktree",
]
