"""Repository cloning and management for Jeeves.

This module handles cloning and updating repositories using the GitHub CLI (gh).
"""

import json
import subprocess
from pathlib import Path
from typing import Optional

from .paths import get_repo_path, ensure_directory


class RepoError(Exception):
    """Error during repository operations."""

    pass


class AuthenticationError(RepoError):
    """Error when GitHub authentication is missing or invalid.

    This error provides user-friendly messages with actionable steps.
    """

    pass


def run_git(
    args: list[str],
    cwd: Optional[Path] = None,
    capture: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a git command.

    Args:
        args: Git command arguments (without 'git' prefix).
        cwd: Working directory. Defaults to current directory.
        capture: Whether to capture output.
        check: Whether to raise on non-zero exit.

    Returns:
        CompletedProcess instance.

    Raises:
        RepoError: If command fails and check=True.
    """
    cmd = ["git"] + args
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=capture,
            text=True,
            timeout=300,  # 5 minute timeout for clone/fetch
        )
        if check and result.returncode != 0:
            error_msg = result.stderr.strip() if result.stderr else f"git {args[0]} failed"
            raise RepoError(error_msg)
        return result
    except subprocess.TimeoutExpired as e:
        raise RepoError(f"git {args[0]} timed out after 5 minutes") from e
    except FileNotFoundError:
        raise RepoError("git is not installed or not in PATH")


def run_gh(
    args: list[str],
    cwd: Optional[Path] = None,
    capture: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a GitHub CLI command.

    Args:
        args: gh command arguments (without 'gh' prefix).
        cwd: Working directory. Defaults to current directory.
        capture: Whether to capture output.
        check: Whether to raise on non-zero exit.

    Returns:
        CompletedProcess instance.

    Raises:
        RepoError: If command fails and check=True.
    """
    cmd = ["gh"] + args
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=capture,
            text=True,
            timeout=300,  # 5 minute timeout for clone
        )
        if check and result.returncode != 0:
            error_msg = result.stderr.strip() if result.stderr else f"gh {args[0]} failed"
            raise RepoError(error_msg)
        return result
    except subprocess.TimeoutExpired as e:
        raise RepoError(f"gh {args[0]} timed out after 5 minutes") from e
    except FileNotFoundError:
        raise RepoError(
            "GitHub CLI (gh) is not installed or not in PATH. "
            "Install from: https://cli.github.com/"
        )


def is_gh_authenticated() -> bool:
    """Check if GitHub CLI is authenticated.

    Returns:
        True if authenticated.
    """
    try:
        result = run_gh(["auth", "status"], check=False)
        return result.returncode == 0
    except RepoError:
        return False


def check_gh_auth_for_browse() -> None:
    """Verify GitHub CLI authentication before browse operations.

    This function should be called before any operation that requires
    browsing GitHub repositories or issues. It provides a user-friendly
    error message with actionable steps if authentication is missing.

    Raises:
        AuthenticationError: If not authenticated with GitHub CLI.
    """
    if not is_gh_authenticated():
        raise AuthenticationError(
            "GitHub CLI is not authenticated. "
            "Please run 'gh auth login' to authenticate with GitHub before browsing repositories or issues."
        )


def list_user_repos(limit: int = 30) -> list[dict]:
    """List user's repositories via gh repo list.

    Fetches repositories owned by the authenticated user.

    Args:
        limit: Maximum number of repositories to return. Defaults to 30.

    Returns:
        List of repository dictionaries with keys:
        - name: Repository name
        - owner: Repository owner login
        - description: Repository description (may be None)
        - updatedAt: Last update timestamp in ISO format

    Raises:
        RepoError: If the gh command fails.
    """
    result = run_gh([
        "repo", "list",
        "--json", "name,owner,description,updatedAt",
        "--limit", str(limit),
    ])

    repos_data = json.loads(result.stdout)

    # Normalize the output structure
    return [
        {
            "name": repo["name"],
            "owner": repo["owner"]["login"],
            "description": repo.get("description"),
            "updatedAt": repo.get("updatedAt"),
        }
        for repo in repos_data
    ]


def list_contributed_repos(limit: int = 20) -> list[dict]:
    """List repositories user has contributed to.

    Uses the --source flag to get repositories where the user is
    not the owner but has made contributions.

    Args:
        limit: Maximum number of repositories to return. Defaults to 20.

    Returns:
        List of repository dictionaries with keys:
        - name: Repository name
        - owner: Repository owner login
        - description: Repository description (may be None)
        - updatedAt: Last update timestamp in ISO format

    Raises:
        RepoError: If the gh command fails.
    """
    result = run_gh([
        "repo", "list",
        "--source",
        "--json", "name,owner,description,updatedAt",
        "--limit", str(limit),
    ])

    repos_data = json.loads(result.stdout)

    # Normalize the output structure
    return [
        {
            "name": repo["name"],
            "owner": repo["owner"]["login"],
            "description": repo.get("description"),
            "updatedAt": repo.get("updatedAt"),
        }
        for repo in repos_data
    ]


def ensure_repo(owner: str, repo: str, fetch: bool = True) -> Path:
    """Ensure a repository is cloned and optionally fetched.

    Uses gh CLI for authentication handling.

    Args:
        owner: Repository owner (e.g., 'anthropics').
        repo: Repository name (e.g., 'claude-code').
        fetch: Whether to fetch if repo already exists.

    Returns:
        Path to the cloned repository.

    Raises:
        RepoError: If cloning or fetching fails.
    """
    repo_path = get_repo_path(owner, repo)

    if repo_path.exists():
        # Repository already cloned - optionally fetch
        if fetch:
            fetch_repo(repo_path)
        return repo_path

    # Clone the repository
    clone_repo(owner, repo, repo_path)
    return repo_path


def clone_repo(owner: str, repo: str, target_path: Path) -> None:
    """Clone a repository using gh CLI.

    Args:
        owner: Repository owner.
        repo: Repository name.
        target_path: Where to clone to.

    Raises:
        RepoError: If cloning fails.
    """
    # Ensure parent directory exists
    ensure_directory(target_path.parent)

    # Use gh for authentication handling
    repo_spec = f"{owner}/{repo}"

    try:
        run_gh(["repo", "clone", repo_spec, str(target_path)])
    except RepoError as e:
        # Clean up partial clone on failure
        if target_path.exists():
            import shutil

            shutil.rmtree(target_path, ignore_errors=True)
        raise RepoError(f"Failed to clone {repo_spec}: {e}") from e


def fetch_repo(repo_path: Path, remote: str = "origin", prune: bool = True) -> None:
    """Fetch updates for a repository.

    Args:
        repo_path: Path to the repository.
        remote: Remote to fetch from.
        prune: Whether to prune deleted remote refs.

    Raises:
        RepoError: If fetching fails.
    """
    args = ["fetch", remote]
    if prune:
        args.append("--prune")

    run_git(args, cwd=repo_path)


def get_default_branch(repo_path: Path, remote: str = "origin") -> str:
    """Get the default branch for a repository.

    Args:
        repo_path: Path to the repository.
        remote: Remote to check.

    Returns:
        Default branch name (e.g., 'main' or 'master').

    Raises:
        RepoError: If unable to determine default branch.
    """
    # Try to get from remote HEAD
    result = run_git(
        ["symbolic-ref", f"refs/remotes/{remote}/HEAD"],
        cwd=repo_path,
        check=False,
    )

    if result.returncode == 0:
        ref = result.stdout.strip()
        prefix = f"refs/remotes/{remote}/"
        if ref.startswith(prefix):
            return ref[len(prefix) :]

    # Fallback: check for common default branches
    for branch in ["main", "master"]:
        result = run_git(
            ["show-ref", "--verify", f"refs/remotes/{remote}/{branch}"],
            cwd=repo_path,
            check=False,
        )
        if result.returncode == 0:
            return branch

    # Last resort
    return "main"


def get_repo_remote_url(repo_path: Path, remote: str = "origin") -> Optional[str]:
    """Get the URL for a repository remote.

    Args:
        repo_path: Path to the repository.
        remote: Remote name.

    Returns:
        Remote URL or None if not found.
    """
    result = run_git(
        ["remote", "get-url", remote],
        cwd=repo_path,
        check=False,
    )

    if result.returncode == 0:
        return result.stdout.strip()
    return None


def repo_has_uncommitted_changes(repo_path: Path) -> bool:
    """Check if a repository has uncommitted changes.

    Args:
        repo_path: Path to the repository.

    Returns:
        True if there are uncommitted changes.
    """
    result = run_git(
        ["status", "--porcelain"],
        cwd=repo_path,
        check=False,
    )

    return bool(result.stdout.strip())
