"""Issue state management for Jeeves.

This module handles issue state, including creating, loading, and updating
issue.json files.
"""

import json
import subprocess
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .paths import (
    get_issue_state_dir,
    get_worktree_path,
    ensure_directory,
    parse_repo_spec,
    is_legacy_mode,
)
from .repo import ensure_repo, run_gh, RepoError


class IssueError(Exception):
    """Error during issue operations."""

    pass


@dataclass
class IssueStatus:
    """Status tracking for an issue."""

    implemented: bool = False
    pr_created: bool = False
    pr_description_ready: bool = False
    review_clean: bool = False
    review_passes: int = 0
    review_clean_passes: int = 0
    ci_clean: bool = False
    ci_passes: int = 0
    coverage_clean: bool = False
    coverage_needs_fix: bool = False
    coverage_passes: int = 0
    sonar_clean: bool = False
    current_task_id: Optional[str] = None
    task_stage: str = "implement"
    tasks_complete: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary with camelCase keys for JSON."""
        return {
            "implemented": self.implemented,
            "prCreated": self.pr_created,
            "prDescriptionReady": self.pr_description_ready,
            "reviewClean": self.review_clean,
            "reviewPasses": self.review_passes,
            "reviewCleanPasses": self.review_clean_passes,
            "ciClean": self.ci_clean,
            "ciPasses": self.ci_passes,
            "coverageClean": self.coverage_clean,
            "coverageNeedsFix": self.coverage_needs_fix,
            "coveragePasses": self.coverage_passes,
            "sonarClean": self.sonar_clean,
            "currentTaskId": self.current_task_id,
            "taskStage": self.task_stage,
            "tasksComplete": self.tasks_complete,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "IssueStatus":
        """Create from dictionary."""
        return cls(
            implemented=data.get("implemented", False),
            pr_created=data.get("prCreated", False),
            pr_description_ready=data.get("prDescriptionReady", False),
            review_clean=data.get("reviewClean", False),
            review_passes=data.get("reviewPasses", 0),
            review_clean_passes=data.get("reviewCleanPasses", 0),
            ci_clean=data.get("ciClean", False),
            ci_passes=data.get("ciPasses", 0),
            coverage_clean=data.get("coverageClean", False),
            coverage_needs_fix=data.get("coverageNeedsFix", False),
            coverage_passes=data.get("coveragePasses", 0),
            sonar_clean=data.get("sonarClean", False),
            current_task_id=data.get("currentTaskId"),
            task_stage=data.get("taskStage", "implement"),
            tasks_complete=data.get("tasksComplete", False),
        )


@dataclass
class PullRequest:
    """Pull request information."""

    number: Optional[int] = None
    url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = {}
        if self.number is not None:
            result["number"] = self.number
        if self.url is not None:
            result["url"] = self.url
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PullRequest":
        """Create from dictionary."""
        return cls(
            number=data.get("number"),
            url=data.get("url"),
        )


@dataclass
class GitHubIssue:
    """GitHub issue information."""

    number: int
    title: Optional[str] = None
    url: Optional[str] = None
    repo: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = {"number": self.number}
        if self.title:
            result["title"] = self.title
        if self.url:
            result["url"] = self.url
        if self.repo:
            result["repo"] = self.repo
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "GitHubIssue":
        """Create from dictionary."""
        return cls(
            number=data.get("number", 0),
            title=data.get("title"),
            url=data.get("url"),
            repo=data.get("repo"),
        )


@dataclass
class Task:
    """A task within an issue."""

    id: str
    title: str
    summary: str = ""
    status: str = "pending"  # pending, in_progress, done

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Task":
        """Create from dictionary."""
        return cls(
            id=data.get("id", ""),
            title=data.get("title", ""),
            summary=data.get("summary", ""),
            status=data.get("status", "pending"),
        )


@dataclass
class IssueState:
    """Complete issue state.

    This is the Python representation of issue.json.
    """

    # Repository information
    owner: str
    repo: str

    # Issue information
    issue: GitHubIssue

    # Branch and paths
    branch_name: str
    design_doc_path: Optional[str] = None

    # Status
    status: IssueStatus = field(default_factory=IssueStatus)

    # Pull request
    pull_request: PullRequest = field(default_factory=PullRequest)

    # Tasks
    tasks: List[Task] = field(default_factory=list)

    # Notes
    notes: str = ""

    # Project name (legacy)
    project: Optional[str] = None

    # Paths (populated when loading)
    _state_dir: Optional[Path] = field(default=None, repr=False)
    _worktree_dir: Optional[Path] = field(default=None, repr=False)

    @property
    def issue_number(self) -> int:
        """Get the issue number."""
        return self.issue.number

    @property
    def state_dir(self) -> Path:
        """Get the state directory for this issue."""
        if self._state_dir:
            return self._state_dir
        return get_issue_state_dir(self.owner, self.repo, self.issue.number)

    @property
    def worktree_dir(self) -> Path:
        """Get the worktree directory for this issue."""
        if self._worktree_dir:
            return self._worktree_dir
        return get_worktree_path(self.owner, self.repo, self.issue.number)

    @property
    def issue_file(self) -> Path:
        """Get the path to issue.json."""
        return self.state_dir / "issue.json"

    @property
    def progress_file(self) -> Path:
        """Get the path to progress.txt."""
        return self.state_dir / "progress.txt"

    @property
    def runs_dir(self) -> Path:
        """Get the path to .runs directory."""
        return self.state_dir / ".runs"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result: Dict[str, Any] = {
            "project": self.project or self.repo,
            "branchName": self.branch_name,
            "issue": self.issue.to_dict(),
            "status": self.status.to_dict(),
            "notes": self.notes,
        }

        # Add repo if it differs from issue.repo
        full_repo = f"{self.owner}/{self.repo}"
        if self.issue.repo and self.issue.repo != full_repo:
            result["issue"]["repo"] = self.issue.repo
        elif not self.issue.repo:
            result["issue"]["repo"] = full_repo

        if self.design_doc_path:
            result["designDocPath"] = self.design_doc_path

        if self.pull_request.number or self.pull_request.url:
            result["pullRequest"] = self.pull_request.to_dict()

        if self.tasks:
            result["tasks"] = [t.to_dict() for t in self.tasks]

        return result

    @classmethod
    def from_dict(
        cls,
        data: Dict[str, Any],
        owner: Optional[str] = None,
        repo: Optional[str] = None,
    ) -> "IssueState":
        """Create from dictionary.

        Args:
            data: Dictionary from issue.json.
            owner: Repository owner (inferred from data if not provided).
            repo: Repository name (inferred from data if not provided).

        Returns:
            IssueState instance.
        """
        # Extract issue info
        issue_data = data.get("issue", {})
        if isinstance(issue_data, int):
            issue_data = {"number": issue_data}

        issue = GitHubIssue.from_dict(issue_data)

        # Try to get owner/repo from issue.repo or data
        if issue.repo:
            try:
                owner, repo = parse_repo_spec(issue.repo)
            except ValueError:
                pass

        if not owner or not repo:
            # Fallback to project name
            project = data.get("project", "")
            if "/" in project:
                owner, repo = project.split("/", 1)
            elif project:
                owner = owner or "unknown"
                repo = project
            else:
                owner = owner or "unknown"
                repo = repo or "unknown"

        return cls(
            owner=owner,
            repo=repo,
            issue=issue,
            branch_name=data.get("branchName", f"issue/{issue.number}"),
            design_doc_path=data.get("designDocPath") or data.get("designDoc"),
            status=IssueStatus.from_dict(data.get("status", {})),
            pull_request=PullRequest.from_dict(data.get("pullRequest", {})),
            tasks=[Task.from_dict(t) for t in data.get("tasks", [])],
            notes=data.get("notes", ""),
            project=data.get("project"),
        )

    @classmethod
    def load(
        cls,
        owner: str,
        repo: str,
        issue_number: int,
        state_dir: Optional[Path] = None,
    ) -> "IssueState":
        """Load issue state from file.

        Args:
            owner: Repository owner.
            repo: Repository name.
            issue_number: Issue number.
            state_dir: Override state directory location.

        Returns:
            IssueState instance.

        Raises:
            IssueError: If state file not found or invalid.
        """
        if state_dir is None:
            state_dir = get_issue_state_dir(owner, repo, issue_number)

        issue_file = state_dir / "issue.json"

        if not issue_file.exists():
            raise IssueError(f"Issue state not found: {issue_file}")

        try:
            with open(issue_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            raise IssueError(f"Invalid issue.json: {e}") from e
        except OSError as e:
            raise IssueError(f"Cannot read issue.json: {e}") from e

        state = cls.from_dict(data, owner=owner, repo=repo)
        state._state_dir = state_dir

        return state

    @classmethod
    def load_from_path(cls, path: Path) -> "IssueState":
        """Load issue state from a specific path.

        Args:
            path: Path to issue.json or directory containing it.

        Returns:
            IssueState instance.

        Raises:
            IssueError: If state file not found or invalid.
        """
        if path.is_dir():
            state_dir = path
            issue_file = path / "issue.json"
        else:
            state_dir = path.parent
            issue_file = path

        if not issue_file.exists():
            raise IssueError(f"Issue state not found: {issue_file}")

        try:
            with open(issue_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            raise IssueError(f"Invalid issue.json: {e}") from e
        except OSError as e:
            raise IssueError(f"Cannot read issue.json: {e}") from e

        state = cls.from_dict(data)
        state._state_dir = state_dir

        return state

    def save(self) -> None:
        """Save issue state to file."""
        ensure_directory(self.state_dir)

        issue_file = self.issue_file
        tmp_file = issue_file.with_suffix(".json.tmp")

        try:
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(self.to_dict(), f, indent=2)
                f.write("\n")
            tmp_file.replace(issue_file)
        except OSError as e:
            tmp_file.unlink(missing_ok=True)
            raise IssueError(f"Cannot save issue.json: {e}") from e


def create_issue_state(
    owner: str,
    repo: str,
    issue_number: int,
    branch: Optional[str] = None,
    design_doc: Optional[str] = None,
    fetch_metadata: bool = True,
    force: bool = False,
) -> IssueState:
    """Create a new issue state.

    Args:
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.
        branch: Branch name. Auto-generated if not provided.
        design_doc: Path to design document.
        fetch_metadata: Whether to fetch issue metadata from GitHub.
        force: Overwrite existing state.

    Returns:
        IssueState instance.

    Raises:
        IssueError: If state already exists (and not force).
    """
    state_dir = get_issue_state_dir(owner, repo, issue_number)

    if state_dir.exists() and (state_dir / "issue.json").exists() and not force:
        raise IssueError(
            f"Issue state already exists at {state_dir}. "
            "Use --force to overwrite."
        )

    # Generate branch name if not provided
    if not branch:
        branch = f"issue/{issue_number}"

    # Fetch issue metadata from GitHub
    issue = GitHubIssue(number=issue_number)

    if fetch_metadata:
        try:
            issue = fetch_issue_metadata(owner, repo, issue_number)
        except RepoError:
            # Continue without metadata
            pass

    state = IssueState(
        owner=owner,
        repo=repo,
        issue=issue,
        branch_name=branch,
        design_doc_path=design_doc,
        project=repo,
    )
    state._state_dir = state_dir

    # Save the state
    state.save()

    return state


def fetch_issue_metadata(owner: str, repo: str, issue_number: int) -> GitHubIssue:
    """Fetch issue metadata from GitHub.

    Args:
        owner: Repository owner.
        repo: Repository name.
        issue_number: Issue number.

    Returns:
        GitHubIssue with metadata.

    Raises:
        RepoError: If fetching fails.
    """
    result = run_gh(
        [
            "issue",
            "view",
            str(issue_number),
            "--repo",
            f"{owner}/{repo}",
            "--json",
            "number,title,url",
        ],
        check=False,
    )

    if result.returncode != 0:
        raise RepoError(f"Failed to fetch issue #{issue_number}")

    try:
        data = json.loads(result.stdout)
        return GitHubIssue(
            number=data.get("number", issue_number),
            title=data.get("title"),
            url=data.get("url"),
            repo=f"{owner}/{repo}",
        )
    except json.JSONDecodeError:
        return GitHubIssue(number=issue_number, repo=f"{owner}/{repo}")


def list_issues(owner: Optional[str] = None, repo: Optional[str] = None) -> List[Dict]:
    """List all tracked issues.

    Args:
        owner: Filter by owner. If None, list all.
        repo: Filter by repo. If None, list all for owner.

    Returns:
        List of issue info dicts.
    """
    from .paths import get_issues_dir

    issues_dir = get_issues_dir()
    results = []

    if not issues_dir.exists():
        return results

    # Walk the directory structure
    for owner_dir in issues_dir.iterdir():
        if not owner_dir.is_dir():
            continue
        if owner and owner_dir.name != owner:
            continue

        for repo_dir in owner_dir.iterdir():
            if not repo_dir.is_dir():
                continue
            if repo and repo_dir.name != repo:
                continue

            for issue_dir in repo_dir.iterdir():
                if not issue_dir.is_dir():
                    continue

                issue_file = issue_dir / "issue.json"
                if not issue_file.exists():
                    continue

                try:
                    with open(issue_file, "r", encoding="utf-8") as f:
                        data = json.load(f)

                    issue_data = data.get("issue", {})
                    if isinstance(issue_data, int):
                        issue_number = issue_data
                        issue_title = ""
                    else:
                        issue_number = issue_data.get("number", 0)
                        issue_title = issue_data.get("title", "")

                    results.append(
                        {
                            "owner": owner_dir.name,
                            "repo": repo_dir.name,
                            "issue_number": issue_number,
                            "issue_title": issue_title,
                            "branch": data.get("branchName", ""),
                            "state_dir": str(issue_dir),
                            "status": data.get("status", {}),
                        }
                    )
                except (json.JSONDecodeError, OSError):
                    continue

    return sorted(results, key=lambda x: (x["owner"], x["repo"], x["issue_number"]))
