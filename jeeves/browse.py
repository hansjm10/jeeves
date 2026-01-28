"""Interactive selection utilities for browsing GitHub repositories and issues.

This module provides functions for interactive user selection of repositories
and issues via numbered menus in the terminal.
"""

from typing import List, Tuple

from .repo import list_user_repos
from .issue import list_github_issues, list_assigned_issues


class BrowseError(Exception):
    """Error during browse operations."""

    pass


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
    for selection.

    Returns:
        Tuple of (owner, repo_name).

    Raises:
        BrowseError: If no repositories found or user cancels.
    """
    repos = list_user_repos()

    if not repos:
        raise BrowseError("No repositories found. You may need to create a repository first.")

    # Format repository options
    options = []
    for repo in repos:
        owner = repo["owner"]
        name = repo["name"]
        desc = repo.get("description") or ""

        if desc:
            # Truncate long descriptions
            if len(desc) > 50:
                desc = desc[:47] + "..."
            option = f"{owner}/{name} - {desc}"
        else:
            option = f"{owner}/{name}"

        options.append(option)

    # Get user selection
    selected_idx = prompt_choice(options, "Select a repository:")

    selected_repo = repos[selected_idx]
    return selected_repo["owner"], selected_repo["name"]


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
