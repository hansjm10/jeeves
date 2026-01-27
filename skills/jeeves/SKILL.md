---
name: jeeves
description: "Set up Jeeves for issue-based autonomous agent workflows. Use when you want to configure Jeeves to work on a GitHub issue. Triggers on: set up jeeves, configure jeeves, jeeves issue setup, init jeeves."
---

# Jeeves Issue Setup

Helps configure Jeeves for autonomous issue-based workflows.

---

## The Job

Set up `jeeves/issue.json` to configure Jeeves for working on a GitHub issue.

---

## Output Format

```json
{
  "project": "[Project Name]",
  "branchName": "issue/[issue-number]-[feature-name-kebab-case]",
  "issue": {
    "number": [issue number],
    "repo": "[owner/repo]"
  },
  "designDocPath": "docs/[feature-name]-design.md",
  "status": {
    "implemented": false,
    "prCreated": false,
    "prDescriptionReady": false,
    "reviewClean": false,
    "reviewPasses": 0,
    "reviewCleanPasses": 0,
    "ciClean": false,
    "ciPasses": 0,
    "coverageClean": false,
    "coverageNeedsFix": false,
    "coveragePasses": 0,
    "sonarClean": false
  },
  "config": {
    "reviewCleanPassesRequired": 3,
    "autoSkipTaskReviews": false
  }
}
```

---

## Workflow Phases

Jeeves advances through these phases based on status:

1. **Design** - Draft design doc (when `designDocPath` is missing or file doesn't exist)
2. **Task Loop** - If tasks are defined, implement each with TDD
3. **Implement** - Write code and open PR (until `implemented=true`, `prCreated=true`, `prDescriptionReady=true`)
4. **Review** - Fix issues until `reviewClean=true` (requires multiple clean passes)
5. **Coverage** - Add tests and improve coverage (until `coverageClean=true`)
6. **Sonar** - Fix Sonar issues (until `sonarClean=true`)
7. **CI** - Verify CI passes (until `ciClean=true`)

---

## Using init-issue.sh

The easiest way to create `jeeves/issue.json`:

```bash
./scripts/jeeves/init-issue.sh --issue <number> [--design-doc <path>]
```

Options:
- `--issue <number>` - GitHub issue number (required)
- `--design-doc <path>` - Path to existing design doc
- `--force` - Overwrite existing issue.json

---

## Task Breakdown (Optional)

For larger issues, add a `tasks` array:

```json
{
  "tasks": [
    {
      "id": "T1",
      "title": "Add database schema",
      "description": "Create migration for new table",
      "status": "pending"
    },
    {
      "id": "T2",
      "title": "Implement API endpoint",
      "description": "Create REST endpoint with validation",
      "status": "pending"
    }
  ]
}
```

Each task goes through: implement → spec review → quality review.

---

## Checklist Before Running

- [ ] `jeeves/issue.json` exists with valid issue number
- [ ] GitHub issue has clear requirements
- [ ] Design doc exists (or Jeeves will create one)
- [ ] Branch is created or will be created from main
- [ ] CI is configured for the repository
