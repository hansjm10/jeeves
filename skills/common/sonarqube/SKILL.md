---
name: sonarqube
description: "Access SonarQube or SonarCloud issues and quality gate data via API. Triggers on: /sonarqube, sonar issues, quality gate, code smells, SonarCloud, sonar status."
---

# SonarQube Access

Fetch and analyze code quality data from SonarQube or SonarCloud using their REST API. Use this skill to check quality gates, retrieve issue lists, and integrate static analysis results into your workflow.

---

## The Job

Access SonarQube/SonarCloud API to retrieve:
- Quality gate status for PRs and branches
- Issues (bugs, vulnerabilities, code smells)
- Leak-period problems (new issues since baseline)

Set `status.sonarClean = true` when all quality gates pass and no new issues exist.

---

## Authentication Setup

### Environment Variables

```bash
# Required: API token with Browse access to the project
SONAR_TOKEN=your_token_here

# Optional: Override host (default: https://sonarcloud.io)
SONAR_HOST_URL=https://sonarcloud.io
```

### Token Sources (in order of preference)

1. `SONAR_TOKEN` environment variable
2. Local `.env.sonarcloud` file (add to `.gitignore`)

Load from file when needed:

```bash
SONAR_TOKEN=$(sed -n 's/^SONAR_TOKEN=//p' .env.sonarcloud)
```

---

## API Authentication

Bearer auth (recommended):

```bash
curl -sSf -H "Authorization: Bearer $SONAR_TOKEN" \
  "$SONAR_HOST_URL/api/authentication/validate"
```

Basic auth (empty password):

```bash
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/authentication/validate"
```

---

## Common API Calls

### Quality Gate Status

Check if a PR passes quality gates:

```bash
SONAR_HOST_URL=${SONAR_HOST_URL:-https://sonarcloud.io}
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/qualitygates/project_status?organization=<org>&projectKey=<projectKey>&pullRequest=<pr>"
```

### Issues for a Pull Request

```bash
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?organization=<org>&projectKeys=<projectKey>&pullRequest=<pr>&statuses=OPEN,CONFIRMED"
```

If API returns 400, retry without `statuses`:

```bash
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?organization=<org>&projectKeys=<projectKey>&pullRequest=<pr>"
```

### Issues for a Branch

```bash
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?organization=<org>&projectKeys=<projectKey>&branch=<branch>&statuses=OPEN,CONFIRMED"
```

### Leak-Period Issues (New Since Baseline)

```bash
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?organization=<org>&componentKeys=<componentKey>&sinceLeakPeriod=true"
```

### Issue Details

```bash
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?organization=<org>&projectKeys=<projectKey>&issues=<issueKey>"
```

---

## Issue Categories

SonarQube classifies issues into three types:

| Type | Description | Severity Range |
|------|-------------|----------------|
| **BUG** | Code that is demonstrably wrong or will cause unexpected behavior | BLOCKER, CRITICAL, MAJOR, MINOR, INFO |
| **VULNERABILITY** | Security-sensitive code that could be exploited | BLOCKER, CRITICAL, MAJOR, MINOR, INFO |
| **CODE_SMELL** | Maintainability issues that make code harder to understand or modify | BLOCKER, CRITICAL, MAJOR, MINOR, INFO |

### Severity Levels

- **BLOCKER**: Must be fixed immediately; code cannot ship
- **CRITICAL**: Must be fixed before merge
- **MAJOR**: Should be fixed; impacts maintainability
- **MINOR**: Nice to fix; minor impact
- **INFO**: Informational; low priority

---

## Mapping Issues to Files

Issue `component` fields use format: `org_projectKey:path/to/file`

Strip the project prefix to map to local paths:

```bash
jq -r '.issues[] | {key,rule,severity,type,component,line,message} | @json'
```

Example mapping:

```
component: "myorg_myproject:src/utils/helper.ts"
local path: src/utils/helper.ts
```

---

## Integration with Jeeves Status

After checking SonarQube, update `.jeeves/issue.json`:

```json
{
  "status": {
    "sonarClean": true
  }
}
```

Set `sonarClean` to:
- `true`: Quality gate passes AND no new issues in leak period
- `false`: Quality gate fails OR new issues found

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| **401/403** | Token missing or insufficient permissions | Ensure token has Browse access to project/org |
| **400** | Invalid query parameters | Remove optional params; confirm `organization` and `projectKeys` |
| **Empty results** | No analysis run | Ensure PR/branch has completed Sonar analysis |

### Common Issues

1. **`sinceLeakPeriod` returns 400**: Requires `componentKeys` instead of `projectKeys`
2. **`issues/show` returns 404**: Use `issues/search` with `issues=<key>` parameter
3. **Missing organization**: SonarCloud requires `organization` parameter; SonarQube does not
