#!/usr/bin/env python3
"""Jeeves CLI - Command-line interface for managing autonomous coding sessions.

Usage:
    jeeves init --repo owner/repo --issue 123
    jeeves run owner/repo#123
    jeeves list
    jeeves resume
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import click

from .config import GlobalConfig
from .issue import (
    IssueError,
    IssueState,
    create_issue_state,
    list_issues,
)
from .paths import (
    get_data_dir,
    get_issue_state_dir,
    get_worktree_path,
    is_legacy_mode,
    parse_issue_ref,
    parse_repo_spec,
)
from .repo import RepoError, ensure_repo, fetch_repo, get_default_branch
from .worktree import WorktreeError, create_worktree


@click.group()
@click.version_option(version="0.1.0", prog_name="jeeves")
def main():
    """Jeeves - Autonomous coding agent for GitHub issues.

    Jeeves manages repository clones and worktrees to work on GitHub issues
    autonomously. Each issue gets its own isolated worktree.

    \b
    Quick start:
        jeeves init --repo owner/repo --issue 123
        jeeves run owner/repo#123
    """
    pass


@main.command()
@click.option(
    "--repo",
    "-r",
    required=True,
    help="Repository in owner/repo format.",
)
@click.option(
    "--issue",
    "-i",
    required=True,
    type=int,
    help="Issue number to work on.",
)
@click.option(
    "--branch",
    "-b",
    default=None,
    help="Branch name. Defaults to issue/{number}.",
)
@click.option(
    "--design-doc",
    "-d",
    default=None,
    help="Path to design document.",
)
@click.option(
    "--force",
    "-f",
    is_flag=True,
    help="Overwrite existing issue state.",
)
@click.option(
    "--no-fetch",
    is_flag=True,
    help="Skip fetching issue metadata from GitHub.",
)
def init(
    repo: str,
    issue: int,
    branch: Optional[str],
    design_doc: Optional[str],
    force: bool,
    no_fetch: bool,
):
    """Initialize a new issue for Jeeves to work on.

    This command:
    1. Clones the repository (if not already cloned)
    2. Creates a git worktree for the issue
    3. Sets up issue state tracking

    \b
    Examples:
        jeeves init --repo anthropics/claude-code --issue 123
        jeeves init -r owner/repo -i 456 --branch feature/my-feature
    """
    try:
        owner, repo_name = parse_repo_spec(repo)
    except ValueError as e:
        raise click.ClickException(str(e))

    click.echo(f"Initializing issue #{issue} for {owner}/{repo_name}...")

    # Step 1: Clone/fetch repository
    click.echo("  Ensuring repository is cloned...")
    try:
        repo_path = ensure_repo(owner, repo_name, fetch=True)
        click.echo(f"    Repository: {repo_path}")
    except RepoError as e:
        raise click.ClickException(f"Failed to clone repository: {e}")

    # Step 2: Create issue state
    click.echo("  Creating issue state...")
    try:
        state = create_issue_state(
            owner=owner,
            repo=repo_name,
            issue_number=issue,
            branch=branch,
            design_doc=design_doc,
            fetch_metadata=not no_fetch,
            force=force,
        )
        click.echo(f"    State: {state.state_dir}")
        if state.issue.title:
            click.echo(f"    Title: {state.issue.title}")
    except IssueError as e:
        raise click.ClickException(str(e))

    # Step 3: Create worktree
    click.echo("  Creating git worktree...")
    try:
        worktree_path = create_worktree(
            owner=owner,
            repo=repo_name,
            issue_number=issue,
            branch=state.branch_name,
        )
        state._worktree_dir = worktree_path
        click.echo(f"    Worktree: {worktree_path}")
        click.echo(f"    Branch: {state.branch_name}")
    except WorktreeError as e:
        raise click.ClickException(f"Failed to create worktree: {e}")

    click.echo()
    click.echo(click.style("Ready!", fg="green", bold=True))
    click.echo(f"  Run: jeeves run {owner}/{repo_name}#{issue}")


@main.command()
@click.argument("issue_ref")
@click.option(
    "--max-iterations",
    "-n",
    type=int,
    default=None,
    help="Maximum iterations to run.",
)
@click.option(
    "--runner",
    type=click.Choice(["sdk", "claude", "codex"]),
    default=None,
    help="Runner to use. Defaults to sdk.",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Print what would be done without running.",
)
def run(
    issue_ref: str,
    max_iterations: Optional[int],
    runner: Optional[str],
    dry_run: bool,
):
    """Run Jeeves on an issue.

    ISSUE_REF should be in the format owner/repo#123.

    \b
    Examples:
        jeeves run anthropics/claude-code#123
        jeeves run owner/repo#456 --max-iterations 5
    """
    # Parse issue reference
    try:
        owner, repo, issue_number = parse_issue_ref(issue_ref)
    except ValueError as e:
        raise click.ClickException(str(e))

    # Load issue state
    try:
        state = IssueState.load(owner, repo, issue_number)
    except IssueError as e:
        raise click.ClickException(
            f"Issue not initialized: {e}\n"
            f"Run: jeeves init --repo {owner}/{repo} --issue {issue_number}"
        )

    # Verify worktree exists
    worktree_path = get_worktree_path(owner, repo, issue_number)
    if not worktree_path.exists():
        raise click.ClickException(
            f"Worktree not found at {worktree_path}\n"
            f"Run: jeeves init --repo {owner}/{repo} --issue {issue_number}"
        )

    # Load config for defaults
    config = GlobalConfig.load()

    if runner is None:
        runner = config.default_runner
    if max_iterations is None:
        max_iterations = config.default_max_iterations

    click.echo(f"Running Jeeves on {owner}/{repo}#{issue_number}")
    click.echo(f"  Worktree: {worktree_path}")
    click.echo(f"  State: {state.state_dir}")
    click.echo(f"  Runner: {runner}")
    click.echo(f"  Max iterations: {max_iterations}")

    if dry_run:
        click.echo()
        click.echo(click.style("(dry run - not executing)", fg="yellow"))
        return

    # Find jeeves.sh
    jeeves_sh = Path(__file__).parent.parent / "jeeves.sh"
    if not jeeves_sh.exists():
        raise click.ClickException(f"jeeves.sh not found at {jeeves_sh}")

    # Set up environment
    env = os.environ.copy()
    env["JEEVES_STATE_DIR"] = str(state.state_dir)
    env["JEEVES_WORK_DIR"] = str(worktree_path)
    env["JEEVES_RUNNER"] = runner

    # Build command
    cmd = [str(jeeves_sh), "--max-iterations", str(max_iterations)]
    if runner != "auto":
        cmd += ["--runner", runner]

    click.echo()
    click.echo("Starting agent loop...")

    try:
        result = subprocess.run(
            cmd,
            cwd=str(worktree_path),
            env=env,
        )
        sys.exit(result.returncode)
    except KeyboardInterrupt:
        click.echo("\nInterrupted.")
        sys.exit(130)


@main.command("list")
@click.option(
    "--repo",
    "-r",
    default=None,
    help="Filter by repository (owner/repo or just repo).",
)
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help="Output as JSON.",
)
def list_cmd(repo: Optional[str], as_json: bool):
    """List all tracked issues.

    \b
    Examples:
        jeeves list
        jeeves list --repo anthropics/claude-code
        jeeves list --json
    """
    owner = None
    repo_name = None

    if repo:
        try:
            owner, repo_name = parse_repo_spec(repo)
        except ValueError:
            # Might just be a repo name
            repo_name = repo

    issues = list_issues(owner=owner, repo=repo_name)

    if not issues:
        if repo:
            click.echo(f"No issues found for {repo}")
        else:
            click.echo("No issues found. Initialize one with 'jeeves init'.")
        return

    if as_json:
        click.echo(json.dumps(issues, indent=2))
        return

    # Group by repo
    by_repo: dict = {}
    for issue in issues:
        key = f"{issue['owner']}/{issue['repo']}"
        if key not in by_repo:
            by_repo[key] = []
        by_repo[key].append(issue)

    for repo_key, repo_issues in sorted(by_repo.items()):
        click.echo(click.style(repo_key, bold=True))
        for issue in repo_issues:
            num = issue["issue_number"]
            title = issue.get("issue_title", "")
            branch = issue.get("branch", "")
            status = issue.get("status", {})

            # Build status indicators
            indicators = []
            if status.get("implemented"):
                indicators.append(click.style("impl", fg="green"))
            if status.get("prCreated"):
                indicators.append(click.style("PR", fg="blue"))
            if status.get("ciClean"):
                indicators.append(click.style("CI", fg="green"))

            status_str = " ".join(indicators) if indicators else ""

            title_str = f" - {title[:50]}..." if title and len(title) > 50 else f" - {title}" if title else ""
            click.echo(f"  #{num}{title_str}")
            if branch:
                click.echo(f"    branch: {branch}")
            if status_str:
                click.echo(f"    status: {status_str}")
        click.echo()


@main.command()
@click.option(
    "--runner",
    type=click.Choice(["sdk", "claude", "codex"]),
    default=None,
    help="Runner to use.",
)
@click.option(
    "--max-iterations",
    "-n",
    type=int,
    default=None,
    help="Maximum iterations.",
)
def resume(runner: Optional[str], max_iterations: Optional[int]):
    """Resume the most recently worked-on issue.

    This command finds the most recently modified issue state and
    runs Jeeves on it.
    """
    issues = list_issues()

    if not issues:
        raise click.ClickException(
            "No issues found. Initialize one with 'jeeves init'."
        )

    # Find the most recently modified issue
    latest = None
    latest_mtime = 0

    for issue in issues:
        state_dir = Path(issue["state_dir"])
        issue_file = state_dir / "issue.json"
        if issue_file.exists():
            mtime = issue_file.stat().st_mtime
            if mtime > latest_mtime:
                latest_mtime = mtime
                latest = issue

    if not latest:
        raise click.ClickException("No valid issues found.")

    issue_ref = f"{latest['owner']}/{latest['repo']}#{latest['issue_number']}"
    click.echo(f"Resuming {issue_ref}")

    # Build run command args
    ctx = click.get_current_context()
    ctx.invoke(run, issue_ref=issue_ref, runner=runner, max_iterations=max_iterations, dry_run=False)


@main.command()
def status():
    """Show Jeeves status and data directory info."""
    data_dir = get_data_dir()

    click.echo(click.style("Jeeves Status", bold=True))
    click.echo()
    click.echo(f"Data directory: {data_dir}")
    click.echo(f"  exists: {data_dir.exists()}")

    if data_dir.exists():
        repos_dir = data_dir / "repos"
        worktrees_dir = data_dir / "worktrees"
        issues_dir = data_dir / "issues"

        if repos_dir.exists():
            repo_count = sum(1 for _ in repos_dir.glob("*/*") if _.is_dir())
            click.echo(f"  repos: {repo_count}")

        if worktrees_dir.exists():
            worktree_count = sum(1 for _ in worktrees_dir.glob("*/*/issue-*") if _.is_dir())
            click.echo(f"  worktrees: {worktree_count}")

        if issues_dir.exists():
            issue_count = sum(1 for _ in issues_dir.glob("*/*/*/issue.json"))
            click.echo(f"  issues: {issue_count}")

    click.echo()
    click.echo(f"Legacy mode: {is_legacy_mode()}")

    # Load and show config
    config = GlobalConfig.load()
    click.echo()
    click.echo(click.style("Configuration", bold=True))
    click.echo(f"  default_runner: {config.default_runner}")
    click.echo(f"  default_max_iterations: {config.default_max_iterations}")


@main.command()
@click.argument("issue_ref")
@click.option(
    "--force",
    "-f",
    is_flag=True,
    help="Force removal even with uncommitted changes.",
)
def clean(issue_ref: str, force: bool):
    """Clean up an issue's worktree and state.

    ISSUE_REF should be in the format owner/repo#123.

    This removes the worktree and optionally the state directory.
    """
    from .worktree import remove_worktree

    try:
        owner, repo, issue_number = parse_issue_ref(issue_ref)
    except ValueError as e:
        raise click.ClickException(str(e))

    worktree_path = get_worktree_path(owner, repo, issue_number)
    state_dir = get_issue_state_dir(owner, repo, issue_number)

    if not worktree_path.exists() and not state_dir.exists():
        click.echo(f"Nothing to clean for {issue_ref}")
        return

    click.echo(f"Cleaning up {owner}/{repo}#{issue_number}")

    # Remove worktree
    if worktree_path.exists():
        click.echo(f"  Removing worktree: {worktree_path}")
        try:
            remove_worktree(owner, repo, issue_number, force=force)
        except WorktreeError as e:
            if not force:
                raise click.ClickException(str(e))
            click.echo(f"    Warning: {e}")

    # Remove state (prompt for confirmation)
    if state_dir.exists():
        if click.confirm(f"  Remove state directory {state_dir}?"):
            import shutil

            shutil.rmtree(state_dir, ignore_errors=True)
            click.echo("    Removed.")
        else:
            click.echo("    Kept state directory.")

    click.echo(click.style("Done.", fg="green"))


if __name__ == "__main__":
    main()
