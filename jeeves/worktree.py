"""Git worktree management for Jeeves.

This module handles creating and managing git worktrees for isolated issue work.
"""

import subprocess
from pathlib import Path
from typing import Optional

from .paths import get_worktree_path, get_repo_path, ensure_directory
from .repo import run_git, RepoError, get_default_branch


class WorktreeError(Exception):
    """Error during worktree operations."""

    pass


def create_worktree(
    owner: str,
    repo: str,
    issue_number: int,
    branch: Optional[str] = None,
    base_branch: Optional[str] = None,
) -> Path:
    """Create a git worktree for an issue.

    Args:
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.
        branch: Branch name. Defaults to 'issue/{issue_number}'.
        base_branch: Branch to base off of. Defaults to default branch.

    Returns:
        Path to the created worktree.

    Raises:
        WorktreeError: If worktree creation fails.
    """
    repo_path = get_repo_path(owner, repo)
    worktree_path = get_worktree_path(owner, repo, issue_number)

    if not repo_path.exists():
        raise WorktreeError(
            f"Repository not found at {repo_path}. Run 'jeeves init' first."
        )

    if worktree_path.exists():
        # Worktree already exists - verify it's valid
        if is_valid_worktree(worktree_path):
            return worktree_path
        else:
            # Clean up invalid worktree
            remove_worktree(owner, repo, issue_number, force=True)

    # Determine branch names
    if branch is None:
        branch = f"issue/{issue_number}"

    if base_branch is None:
        base_branch = get_default_branch(repo_path)

    # Ensure parent directory exists
    ensure_directory(worktree_path.parent)

    # Check if branch already exists
    branch_exists = _branch_exists(repo_path, branch)

    try:
        if branch_exists:
            # Use existing branch
            run_git(
                ["worktree", "add", str(worktree_path), branch],
                cwd=repo_path,
            )
        else:
            # Create new branch from base
            run_git(
                [
                    "worktree",
                    "add",
                    "-b",
                    branch,
                    str(worktree_path),
                    f"origin/{base_branch}",
                ],
                cwd=repo_path,
            )
    except RepoError as e:
        # Clean up on failure
        if worktree_path.exists():
            import shutil

            shutil.rmtree(worktree_path, ignore_errors=True)
        raise WorktreeError(f"Failed to create worktree: {e}") from e

    return worktree_path


def remove_worktree(
    owner: str,
    repo: str,
    issue_number: int,
    force: bool = False,
) -> bool:
    """Remove a git worktree.

    Args:
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.
        force: Force removal even with uncommitted changes.

    Returns:
        True if worktree was removed, False if it didn't exist.

    Raises:
        WorktreeError: If removal fails.
    """
    repo_path = get_repo_path(owner, repo)
    worktree_path = get_worktree_path(owner, repo, issue_number)

    if not worktree_path.exists():
        return False

    if not repo_path.exists():
        # Just remove the directory if repo is gone
        import shutil

        shutil.rmtree(worktree_path, ignore_errors=True)
        return True

    try:
        args = ["worktree", "remove", str(worktree_path)]
        if force:
            args.insert(2, "--force")
        run_git(args, cwd=repo_path)
    except RepoError:
        if force:
            # Last resort: just delete the directory
            import shutil

            shutil.rmtree(worktree_path, ignore_errors=True)
            # Try to prune worktree list
            run_git(["worktree", "prune"], cwd=repo_path, check=False)
        else:
            raise WorktreeError(
                f"Failed to remove worktree at {worktree_path}. "
                "Use --force to remove anyway."
            )

    return True


def list_worktrees(owner: str, repo: str) -> list[dict]:
    """List all worktrees for a repository.

    Args:
        owner: Repository owner.
        repo: Repository name.

    Returns:
        List of worktree info dicts with keys: path, branch, commit, locked.
    """
    repo_path = get_repo_path(owner, repo)

    if not repo_path.exists():
        return []

    try:
        result = run_git(
            ["worktree", "list", "--porcelain"],
            cwd=repo_path,
        )
    except RepoError:
        return []

    worktrees = []
    current = {}

    for line in result.stdout.split("\n"):
        line = line.strip()

        if not line:
            if current and "path" in current:
                worktrees.append(current)
            current = {}
            continue

        if line.startswith("worktree "):
            current["path"] = line[9:]
        elif line.startswith("HEAD "):
            current["commit"] = line[5:]
        elif line.startswith("branch "):
            current["branch"] = line[7:]
        elif line == "locked":
            current["locked"] = True
        elif line == "bare":
            current["bare"] = True
        elif line == "detached":
            current["detached"] = True

    if current and "path" in current:
        worktrees.append(current)

    return worktrees


def get_worktree_branch(worktree_path: Path) -> Optional[str]:
    """Get the current branch of a worktree.

    Args:
        worktree_path: Path to the worktree.

    Returns:
        Branch name or None if detached or invalid.
    """
    try:
        result = run_git(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd=worktree_path,
        )
        branch = result.stdout.strip()
        if branch == "HEAD":
            return None  # Detached HEAD
        return branch
    except RepoError:
        return None


def is_valid_worktree(worktree_path: Path) -> bool:
    """Check if a path is a valid git worktree.

    Args:
        worktree_path: Path to check.

    Returns:
        True if valid worktree.
    """
    if not worktree_path.exists():
        return False

    try:
        result = run_git(
            ["rev-parse", "--is-inside-work-tree"],
            cwd=worktree_path,
            check=False,
        )
        return result.returncode == 0 and result.stdout.strip() == "true"
    except RepoError:
        return False


def prune_worktrees(owner: str, repo: str) -> None:
    """Prune stale worktree information.

    Args:
        owner: Repository owner.
        repo: Repository name.
    """
    repo_path = get_repo_path(owner, repo)

    if repo_path.exists():
        run_git(["worktree", "prune"], cwd=repo_path, check=False)


def _branch_exists(repo_path: Path, branch: str) -> bool:
    """Check if a branch exists locally.

    Args:
        repo_path: Path to repository.
        branch: Branch name.

    Returns:
        True if branch exists.
    """
    result = run_git(
        ["show-ref", "--verify", f"refs/heads/{branch}"],
        cwd=repo_path,
        check=False,
    )
    return result.returncode == 0
