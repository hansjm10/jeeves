"""Issue state management for Jeeves.

This module handles issue state, including creating, loading, and updating
issue.json files.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .paths import (
    get_issue_state_dir,
    get_worktree_path,
    ensure_directory,
    parse_repo_spec,
)
from .repo import ensure_repo, run_gh, RepoError
from .workflow_loader import load_workflow_by_name


class IssueError(Exception):
    """Error during issue operations."""

    pass


@dataclass
class GitHubIssue:
    """GitHub issue information."""

    number: int
    title: Optional[str] = None
    url: Optional[str] = None
    repo: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
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
        return cls(
            number=data.get("number", 0),
            title=data.get("title"),
            url=data.get("url"),
            repo=data.get("repo"),
        )


@dataclass
class IssueState:
    """Minimal issue state for SDK-only viewer."""

    owner: str
    repo: str
    issue: GitHubIssue
    branch: str
    phase: str = "design_draft"
    workflow: str = "default"
    design_doc_path: Optional[str] = None
    notes: str = ""

    _state_dir: Optional[Path] = field(default=None, repr=False)
    _worktree_dir: Optional[Path] = field(default=None, repr=False)

    @property
    def issue_number(self) -> int:
        return self.issue.number

    @property
    def state_dir(self) -> Path:
        if self._state_dir:
            return self._state_dir
        return get_issue_state_dir(self.owner, self.repo, self.issue.number)

    @property
    def worktree_dir(self) -> Path:
        if self._worktree_dir:
            return self._worktree_dir
        return get_worktree_path(self.owner, self.repo, self.issue.number)

    @property
    def issue_file(self) -> Path:
        return self.state_dir / "issue.json"

    @property
    def progress_file(self) -> Path:
        return self.state_dir / "progress.txt"

    def to_dict(self) -> Dict[str, Any]:
        full_repo = f"{self.owner}/{self.repo}"
        issue_dict = self.issue.to_dict()
        if issue_dict.get("repo") is None:
            issue_dict["repo"] = full_repo

        result: Dict[str, Any] = {
            "schemaVersion": 1,
            "repo": full_repo,
            "issue": issue_dict,
            "branch": self.branch,
            "phase": self.phase,
            "workflow": self.workflow,
            "notes": self.notes,
        }
        if self.design_doc_path:
            result["designDocPath"] = self.design_doc_path
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any], owner: Optional[str] = None, repo: Optional[str] = None) -> "IssueState":
        issue_data = data.get("issue", {})
        if isinstance(issue_data, int):
            issue_data = {"number": issue_data}
        issue = GitHubIssue.from_dict(issue_data)

        repo_spec = data.get("repo") or issue.repo
        if repo_spec:
            try:
                owner, repo = parse_repo_spec(repo_spec)
            except ValueError:
                pass

        if not owner or not repo:
            project = data.get("project", "")
            if "/" in project:
                owner, repo = project.split("/", 1)
            elif project:
                owner = owner or "unknown"
                repo = project
            else:
                owner = owner or "unknown"
                repo = repo or "unknown"

        branch = data.get("branch") or data.get("branchName") or f"issue/{issue.number}"
        phase = data.get("phase") or "design_draft"
        workflow = data.get("workflow", "default")

        return cls(
            owner=owner,
            repo=repo,
            issue=issue,
            branch=branch,
            phase=phase,
            workflow=workflow,
            design_doc_path=data.get("designDocPath") or data.get("designDoc"),
            notes=data.get("notes", ""),
        )

    @classmethod
    def load(cls, owner: str, repo: str, issue_number: int, state_dir: Optional[Path] = None) -> "IssueState":
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
    workflow: str = "default",
    fetch_metadata: bool = True,
    force: bool = False,
) -> IssueState:
    state_dir = get_issue_state_dir(owner, repo, issue_number)

    if state_dir.exists() and (state_dir / "issue.json").exists() and not force:
        raise IssueError(
            f"Issue state already exists at {state_dir}. "
            "Use --force to overwrite."
        )

    if not branch:
        branch = f"issue/{issue_number}"

    issue = GitHubIssue(number=issue_number)
    if fetch_metadata:
        try:
            issue = fetch_issue_metadata(owner, repo, issue_number)
        except RepoError:
            pass

    # Load workflow to get the start phase
    try:
        wf = load_workflow_by_name(workflow)
        start_phase = wf.start
    except FileNotFoundError:
        # Fallback to legacy phase if workflow not found
        start_phase = "design_draft"

    state = IssueState(
        owner=owner,
        repo=repo,
        issue=issue,
        branch=branch,
        phase=start_phase,
        workflow=workflow,
        design_doc_path=design_doc,
    )
    state._state_dir = state_dir
    state.save()
    return state


def fetch_issue_metadata(owner: str, repo: str, issue_number: int) -> GitHubIssue:
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


def list_github_issues(owner: str, repo: str, state: str = "open", limit: int = 50) -> List[Dict]:
    try:
        result = run_gh([
            "issue", "list",
            "--repo", f"{owner}/{repo}",
            "--state", state,
            "--json", "number,title,labels,assignees",
            "--limit", str(limit),
        ])
    except Exception as e:
        raise IssueError(f"Failed to list issues for {owner}/{repo}: {e}") from e

    issues_data = json.loads(result.stdout)

    return [
        {
            "number": issue["number"],
            "title": issue["title"],
            "labels": [label["name"] for label in issue.get("labels", [])],
            "assignees": [assignee["login"] for assignee in issue.get("assignees", [])],
        }
        for issue in issues_data
    ]


def list_assigned_issues(owner: str, repo: str, limit: int = 50) -> List[Dict]:
    try:
        result = run_gh([
            "issue", "list",
            "--repo", f"{owner}/{repo}",
            "--assignee", "@me",
            "--json", "number,title,labels,assignees",
            "--limit", str(limit),
        ])
    except Exception as e:
        raise IssueError(f"Failed to list assigned issues for {owner}/{repo}: {e}") from e

    issues_data = json.loads(result.stdout)

    return [
        {
            "number": issue["number"],
            "title": issue["title"],
            "labels": [label["name"] for label in issue.get("labels", [])],
            "assignees": [assignee["login"] for assignee in issue.get("assignees", [])],
        }
        for issue in issues_data
    ]


def list_issues(owner: Optional[str] = None, repo: Optional[str] = None) -> List[Dict]:
    from .paths import get_issues_dir

    issues_dir = get_issues_dir()
    results = []

    if not issues_dir.exists():
        return results

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
                            "branch": data.get("branch") or data.get("branchName", ""),
                            "phase": data.get("phase", "design_draft"),
                            "state_dir": str(issue_dir),
                        }
                    )
                except (json.JSONDecodeError, OSError):
                    continue

    return sorted(results, key=lambda x: (x["owner"], x["repo"], x["issue_number"]))
