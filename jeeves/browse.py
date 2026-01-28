"""Interactive selection utilities for browsing GitHub repositories and issues.

This module provides functions for interactive user selection of repositories
and issues via numbered menus in the terminal, with support for caching
recent selections.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .paths import get_data_dir
from .repo import list_user_repos
from .issue import list_github_issues, list_assigned_issues


class BrowseError(Exception):
    """Error during browse operations."""

    pass


# ---- Recent Selections Cache ----

def get_recent_file_path() -> Path:
    """Get the path to the recent selections cache file.

    Returns:
        Path to recent.json in the Jeeves data directory.
    """
    return get_data_dir() / "recent.json"


def load_recent_selections() -> Dict[str, Any]:
    """Load recent selections from cache file.

    Returns:
        Dict with structure {"repos": [...], "maxRecent": 10}.
        Returns default empty structure if file doesn't exist or is invalid.
    """
    default = {"repos": [], "maxRecent": 10}
    recent_file = get_recent_file_path()

    if not recent_file.exists():
        return default

    try:
        content = recent_file.read_text()
        data = json.loads(content)
        # Validate structure
        if not isinstance(data, dict) or "repos" not in data:
            return default
        return data
    except (json.JSONDecodeError, OSError):
        return default


def save_recent_selections(data: Dict[str, Any]) -> None:
    """Save recent selections to cache file.

    Creates the data directory if it doesn't exist.

    Args:
        data: The recent selections data to save.
    """
    recent_file = get_recent_file_path()
    recent_file.parent.mkdir(parents=True, exist_ok=True)
    recent_file.write_text(json.dumps(data, indent=2))


def record_recent_repo(owner: str, repo: str) -> None:
    """Record a repository selection to the recent cache.

    If the repo is already in the list, updates its timestamp and moves
    it to the front. If the list exceeds maxRecent, removes the oldest entry.

    Args:
        owner: Repository owner.
        repo: Repository name.
    """
    data = load_recent_selections()
    max_recent = data.get("maxRecent", 10)
    repos = data.get("repos", [])

    # Current timestamp
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # Check if repo already exists
    existing_idx = None
    for i, r in enumerate(repos):
        if r.get("owner") == owner and r.get("repo") == repo:
            existing_idx = i
            break

    # Remove existing entry if present
    if existing_idx is not None:
        repos.pop(existing_idx)

    # Add new entry at the front
    new_entry = {"owner": owner, "repo": repo, "lastUsed": now}
    repos.insert(0, new_entry)

    # Trim to max_recent
    repos = repos[:max_recent]

    data["repos"] = repos
    save_recent_selections(data)


def get_recent_repos() -> List[Tuple[str, str]]:
    """Get list of recent repository selections.

    Returns:
        List of (owner, repo) tuples, ordered by most recent first.
    """
    data = load_recent_selections()
    repos = data.get("repos", [])
    return [(r["owner"], r["repo"]) for r in repos if "owner" in r and "repo" in r]


def prompt_choice(options: List[str], prompt: str) -> int:
    """Display numbered options and get user selection.

    Presents a numbered list of options and prompts the user to select one.
    Re-prompts if the input is invalid.

    Args:
        options: List of option strings to display.
        prompt: The prompt message to show the user.

    Returns:
        0-based index of the selected option.

    Raises:
        BrowseError: If options list is empty or user cancels (Ctrl+C/EOF).
    """
    if not options:
        raise BrowseError("No options to display")

    # Display the prompt
    print(prompt)
    print()

    # Display numbered options
    for i, option in enumerate(options, start=1):
        print(f"  [{i}] {option}")

    print()

    # Get user selection
    while True:
        try:
            response = input("Enter number: ").strip()

            if not response:
                continue

            try:
                selection = int(response)
            except ValueError:
                print("Please enter a valid number.")
                continue

            if selection < 1 or selection > len(options):
                print(f"Please enter a number between 1 and {len(options)}.")
                continue

            return selection - 1  # Return 0-based index

        except KeyboardInterrupt:
            raise BrowseError("Selection cancelled by user")
        except EOFError:
            raise BrowseError("Selection cancelled (end of input)")


def select_repository() -> Tuple[str, str]:
    """Interactive repository selection.

    Fetches the user's repositories and presents them in a numbered list
    for selection. Recent selections are shown first with a marker.

    Returns:
        Tuple of (owner, repo_name).

    Raises:
        BrowseError: If no repositories found or user cancels.
    """
    # Get recent repos first
    recent_repos = get_recent_repos()
    recent_set = {(owner, repo) for owner, repo in recent_repos}

    # Get all user repos
    fetched_repos = list_user_repos()

    if not fetched_repos and not recent_repos:
        raise BrowseError("No repositories found. You may need to create a repository first.")

    # Build combined list: recent repos first, then fetched (deduplicated)
    combined_repos: List[Dict[str, Any]] = []

    # Add recent repos first (with marker)
    for owner, repo in recent_repos:
        combined_repos.append({
            "owner": owner,
            "name": repo,
            "description": None,
            "is_recent": True,
        })

    # Add fetched repos (skip duplicates)
    for repo in fetched_repos:
        owner = repo["owner"]
        name = repo["name"]
        if (owner, name) not in recent_set:
            combined_repos.append({
                "owner": owner,
                "name": name,
                "description": repo.get("description"),
                "is_recent": False,
            })

    if not combined_repos:
        raise BrowseError("No repositories found. You may need to create a repository first.")

    # Format repository options
    options = []
    for repo in combined_repos:
        owner = repo["owner"]
        name = repo["name"]
        desc = repo.get("description") or ""
        is_recent = repo.get("is_recent", False)

        # Build base option string
        if desc:
            # Truncate long descriptions
            if len(desc) > 50:
                desc = desc[:47] + "..."
            option = f"{owner}/{name} - {desc}"
        else:
            option = f"{owner}/{name}"

        # Add recent marker
        if is_recent:
            option = f"{option} (recent)"

        options.append(option)

    # Get user selection
    selected_idx = prompt_choice(options, "Select a repository:")

    selected_repo = combined_repos[selected_idx]
    owner = selected_repo["owner"]
    name = selected_repo["name"]

    # Record this selection to recent cache
    record_recent_repo(owner, name)

    return owner, name


def select_issue(owner: str, repo: str) -> int:
    """Interactive issue selection.

    Fetches issues for the specified repository and presents them in a
    numbered list for selection. Issues assigned to the current user
    are shown first.

    Args:
        owner: Repository owner.
        repo: Repository name.

    Returns:
        Issue number.

    Raises:
        BrowseError: If no issues found or user cancels.
    """
    # Get all open issues
    all_issues = list_github_issues(owner, repo, state="open")

    # Get issues assigned to current user
    assigned_issues = list_assigned_issues(owner, repo)

    if not all_issues:
        raise BrowseError(f"No open issues found in {owner}/{repo}.")

    # Build ordered list: assigned issues first, then others
    assigned_numbers = {issue["number"] for issue in assigned_issues}

    ordered_issues = []

    # Add assigned issues first
    for issue in assigned_issues:
        ordered_issues.append(issue)

    # Add remaining issues (not assigned to user)
    for issue in all_issues:
        if issue["number"] not in assigned_numbers:
            ordered_issues.append(issue)

    # Format issue options
    options = []
    for issue in ordered_issues:
        number = issue["number"]
        title = issue["title"]
        labels = issue.get("labels", [])

        # Build option string
        label_str = ""
        if labels:
            label_str = f" [{', '.join(labels[:3])}]"  # Show up to 3 labels

        # Mark assigned issues
        is_assigned = number in assigned_numbers
        assigned_marker = " *" if is_assigned else ""

        option = f"#{number}: {title}{label_str}{assigned_marker}"
        options.append(option)

    # Get user selection
    selected_idx = prompt_choice(options, f"Select an issue from {owner}/{repo}:")

    return ordered_issues[selected_idx]["number"]
