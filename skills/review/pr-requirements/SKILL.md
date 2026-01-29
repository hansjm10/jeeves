---
name: pr-requirements
description: "Extract acceptance criteria and requirements from a GitHub issue. Triggers on: /pr-requirements, extract requirements, acceptance criteria, issue requirements, what should this PR do."
---

# PR Requirements Extractor

Extract acceptance criteria from a GitHub issue for PR review. Produces a structured `requirements_pack` artifact that can be used by other skills (pr-review) or for documentation.

---

## The Job

Extract structured requirements from a GitHub issue to enable evidence-based review of whether a PR meets its stated goals. This skill parses issue content to find explicit acceptance criteria, constraints, non-goals, and ambiguities.

**Key Principle**: Extract what's there. Don't invent requirements.

---

## Invocation

```
/pr-requirements https://github.com/owner/repo/issues/123
/pr-requirements owner/repo#123
/pr-requirements 123              # Uses current repo
```

Or provide issue content directly when prompted.

---

## Process

### Step 1: Fetch Issue Content

```bash
gh issue view {issue_number} --repo {owner}/{repo} --json title,body,labels,milestone
```

### Step 2: Parse Acceptance Criteria

Look for explicit criteria in these formats:
- Checkboxes: `- [ ] Criterion`
- Numbered lists under "Acceptance Criteria" or "Requirements"
- Statements with "must", "should", "shall"
- User stories: "As a X, I want Y, so that Z"

### Step 3: Identify Constraints and Non-Goals

Look for:
- "Out of scope" sections
- "Not included" statements
- "Constraints" or "Limitations"
- Performance or compatibility requirements
- Backward compatibility statements

### Step 4: Note Ambiguities

Identify areas where requirements are unclear:
- Missing edge case definitions
- Undefined behavior specifications
- Conflicting statements
- Implicit assumptions

---

## Output Format

Produce a `requirements_pack` XML artifact:

**If issue exists:**

```xml
<requirements_pack>
  <issue_ref>
    <url>https://github.com/owner/repo/issues/123</url>
    <title>Issue title</title>
  </issue_ref>

  <acceptance_criteria>
    <criterion id="1">
      <text>Users can export data to CSV format</text>
      <source>Issue body, checkbox list item 1</source>
    </criterion>
    <criterion id="2">
      <text>Export includes all visible columns</text>
      <source>Issue body, checkbox list item 2</source>
    </criterion>
    <criterion id="3">
      <text>Large exports (>10k rows) should show progress indicator</text>
      <source>Issue body, under "Performance requirements"</source>
    </criterion>
  </acceptance_criteria>

  <constraints_and_non_goals>
    <item>
      <text>Does not include PDF export (out of scope)</text>
      <source>Issue body, "Out of scope" section</source>
    </item>
    <item>
      <text>Must maintain backward compatibility with v2.x API</text>
      <source>Issue body, "Constraints" section</source>
    </item>
  </constraints_and_non_goals>

  <ambiguities>
    <item>Issue does not specify behavior for empty datasets</item>
    <item>Unclear whether export should include hidden columns</item>
    <item>No performance target specified for exports under 10k rows</item>
  </ambiguities>
</requirements_pack>
```

**If no issue found:**

```xml
<requirements_pack>
  <error>No linked issue found</error>
</requirements_pack>
```

---

## Parsing Patterns

### Checkbox Lists

```markdown
## Acceptance Criteria
- [ ] User can click export button
- [ ] CSV downloads with correct filename
- [ ] All data types are properly formatted
```

### Numbered Requirements

```markdown
## Requirements
1. Support CSV format
2. Support JSON format
3. Include column headers
```

### User Stories

```markdown
As a data analyst, I want to export my filtered results
so that I can analyze them in Excel.
```

### Must/Should Statements

```markdown
The export must include timestamps in ISO 8601 format.
The filename should include the current date.
```

---

## Rules

1. **Quote sources**: Every criterion must cite where it came from in the issue
2. **Preserve wording**: Use the issue's language, don't paraphrase requirements
3. **Number criteria**: Assign IDs for easy reference in review mapping
4. **Flag ambiguities**: Note gaps that could affect review accuracy
5. **Separate constraints**: Distinguish what must be done from what must NOT be done

---

## What to Include

- Explicit acceptance criteria from issue body
- Implicit requirements from context
- Performance/compatibility constraints
- Scope boundaries (what's explicitly excluded)
- Unanswered questions or ambiguities

---

## What NOT to Include

- Invented requirements not in the issue
- Assumptions about intent
- Suggestions for additional features
- Evaluation of whether requirements are good
