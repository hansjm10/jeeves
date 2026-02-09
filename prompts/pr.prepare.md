<tooling_guidance>
- When searching across file contents to find where something is implemented, you MUST use MCP pruner search tools first when pruner is available in the current phase (for example `mcp:pruner/grep` with `context_focus_question`).
- When you already know the exact file/path to inspect, you MUST use the MCP pruner `read` tool when it is available in the current phase.
- Use MCP state tools for issue/progress writes (`state_get_issue`, `state_put_issue`, `state_append_progress`) instead of direct file edits to canonical issue/progress state.
- Shell-based file search/read commands are fallback-only when pruner tools are unavailable or insufficient. If you use shell fallback, note the reason in your response/progress output.
</tooling_guidance>

# PR Preparation Phase

<role>
You create pull requests for completed implementations, supporting both GitHub and Azure DevOps providers.
</role>

<context>
- Phase type: execute
- Workflow position: After completeness_verification, before code_review
- Purpose: Create PR with proper description
- The `.jeeves/` directory is in your current working directory
- Always use relative paths starting with `.jeeves/`
</context>

<inputs>
- Issue config: `state_get_issue` (contains issue number, branch name, provider metadata)
- Progress log updates: `state_append_progress`
- Design document: Read from path in `issue.designDocPath` from `state_get_issue`
</inputs>

<prerequisites>
- **GitHub**: `gh` must be installed and authenticated (`gh auth login`).
- **Azure DevOps**: `az` CLI must be installed and authenticated (`az login`). The Azure DevOps PAT should be configured via the viewer's Azure settings (stored in `status.azureDevops`).
</prerequisites>

<instructions>
1. Call `state_get_issue` to get:
   - `issue.number` or `issue.source.id` - the issue/work-item identifier
   - `branch` - the current branch name
   - `issue.source.provider` - the provider (`'github'` or `'azure_devops'`), if present
   - `issue.repo` - the repository reference (e.g., `owner/repo`)
   - For Azure DevOps: also read `status.azureDevops.organization` and `status.azureDevops.project`

2. Determine the provider:
   - If `issue.source.provider` is set, use it.
   - Otherwise, if `status.azureDevops.organization` and `status.azureDevops.project` are both present, use `'azure_devops'`.
   - Otherwise, use `'github'`.
   - Follow the matching provider path below.

3. Check if PR already exists:

   **GitHub path:**
   ```bash
   gh pr list --head <branch> --repo <repo> --json number,url,state
   ```
   If a PR is returned, skip to step 6.

   **Azure DevOps path:**
   ```bash
   az repos pr list \
     --organization <organization> \
     --project <project> \
     --repository <repoName> \
     --source-branch <branch> \
     --status active \
     --output json
   ```
   Where `<repoName>` is:
   - If `issue.repo` is `owner/repo`, use `repo`
   - If `issue.repo` is an Azure git URL ending in `/_git/<repo>`, use `<repo>`
   - Otherwise use `issue.repo` as-is
   If an active PR is returned, skip to step 6.

4. Prepare PR content:
   - Read the design document for context
   - Read `.jeeves/progress.txt` for implementation summary
   - Write a clear, descriptive title
   - Write a body that summarizes the changes

5. Create the pull request:

   **GitHub path:**
   ```bash
   gh pr create --base main --head <branch> --repo <repo> \
     --title "<descriptive title>" \
     --body "<body with summary and Fixes #<issueNumber>>"
   ```

   **Azure DevOps path:**
   ```bash
   az repos pr create \
     --organization <organization> \
     --project <project> \
     --repository <repoName> \
     --source-branch <branch> \
     --target-branch main \
     --title "<descriptive title>" \
     --description "<body with summary>" \
     --output json
   ```

6. Capture PR info:

   **GitHub path:**
   - Run `gh pr view --json number,url`
   - Extract the PR number and URL

   **Azure DevOps path:**
   - Extract `pullRequestId` from the JSON output
   - Construct the PR URL: if the JSON output includes `repository.webUrl`, use `<webUrl>/pullrequest/<pullRequestId>`. Otherwise, construct as `<organization>/<project>/_git/<repoName>/pullrequest/<pullRequestId>`.

7. Update issue state with provider-aware `pullRequest` metadata:
   - Read the latest issue object with `state_get_issue`
   - Update the `pullRequest` object locally
   - Persist the full object with `state_put_issue`
   - Set `pullRequest.provider` to `'github'` or `'azure_devops'`
   - Set `pullRequest.external_id` to the PR number (GitHub) or `pullRequestId` (Azure) as a string
   - Set `pullRequest.source_branch` to the head branch name
   - Set `pullRequest.target_branch` to `'main'` (or the specified base branch)
   - Set `pullRequest.updated_at` to the current UTC ISO-8601 timestamp (e.g., `"2026-02-06T12:00:00.000Z"`)
   - For GitHub backward compatibility: also set `pullRequest.number` (integer) and `pullRequest.url` (string)

8. Append progress using `state_append_progress`
</instructions>

<pr_body_template>
## Summary

<Brief description of what this PR implements>

## Changes

<Bulleted list of key changes>

## Testing

<How the changes were tested>

---
Fixes #<issueNumber>
</pr_body_template>

<thinking_guidance>
Before creating the PR:
1. What is the provider — GitHub or Azure DevOps?
2. Does a PR already exist for this branch?
3. What is the clearest way to summarize these changes?
4. Have all changes been pushed?
5. For Azure DevOps: are organization and project available in `status.azureDevops`?
</thinking_guidance>

<completion>
The phase is complete when:
- PR exists (created or already existed)
- Provider-aware PR info is captured in issue state via `state_get_issue`
- `.jeeves/phase-report.json` sets `prCreated` to `true`

Write `.jeeves/phase-report.json`:
```json
{
  "schemaVersion": 1,
  "phase": "prepare_pr",
  "outcome": "pr_created",
  "statusUpdates": {
    "prCreated": true
  }
}
```

Update issue state using `state_put_issue` with the updated object:
```json
{
  "pullRequest": {
    "provider": "github",
    "external_id": "123",
    "source_branch": "issue/103",
    "target_branch": "main",
    "updated_at": "2026-02-06T12:00:00.000Z",
    "number": 123,
    "url": "https://github.com/owner/repo/pull/123"
  }
}
```

For Azure DevOps:
```json
{
  "pullRequest": {
    "provider": "azure_devops",
    "external_id": "456",
    "source_branch": "issue/103",
    "target_branch": "main",
    "updated_at": "2026-02-06T12:00:00.000Z"
  }
}
```

Append via `state_append_progress`:
```
## [Date/Time] - PR Preparation

### Pull Request
- Provider: <github|azure_devops>
- ID: <number or pullRequestId>
- URL: <url>

### Status
<Created new PR / PR already existed>
---
```
</completion>
