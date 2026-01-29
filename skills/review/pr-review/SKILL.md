---
name: pr-review
description: "Orchestrate evidence-based PR reviews with self-audit for quality control. Use when reviewing pull requests, providing technical review feedback, or evaluating code changes. Triggers on: review PR, PR review, technical review, code review, /pr-review."
---

# PR Review Orchestrator

Evidence-based PR review workflow with self-audit for quality control.

---

## The Job

Run a complete PR review pipeline that produces evidence-based, audited technical reviews:

1. **Fetch**: Retrieve PR metadata and diff
2. **Evidence**: Extract factual changes from diff (via pr-evidence skill)
3. **Requirements**: Match changes to issue acceptance criteria (via pr-requirements skill)
4. **Review**: Evaluate implementation quality with citations
5. **Audit**: Self-check for false positives (via pr-audit skill)
6. **Finalize**: Produce publishable review

---

## Invocation

```
/pr-review owner/repo#123
/pr-review https://github.com/owner/repo/pull/123
/pr-review 123                    # Uses current repo
/pr-review 123 --issue https://github.com/owner/repo/issues/456
/pr-review 123 --post-comment     # Post comment after review
```

---

## Workflow Phases

```
Phase 0 (fetch) ──┬──► Phase 1 (evidence) ──┬──► Phase 3 (review) ──► Phase 4 (audit) ──► Phase 5 (finalize)
                  └──► Phase 2 (requirements)┘
```

**Parallelization**: Phases 1 and 2 run in parallel after Phase 0 completes.

---

## Phase 0: Fetch PR Data

Use `gh` CLI to fetch PR data:

```bash
# Get PR metadata
gh pr view {pr_number} --repo {owner}/{repo} --json title,body,author,state,baseRefName,headRefName,files,additions,deletions

# Get PR diff
gh pr diff {pr_number} --repo {owner}/{repo}

# Get linked issues (parse from PR body for "Fixes #X", "Closes #X", etc.)
gh issue view {issue_number} --repo {owner}/{repo} --json title,body
```

---

## Phases 1 & 2: Extract Evidence and Requirements (Parallel)

Spawn two subagents **in parallel** using Task tool:

**Task 1: Evidence Extraction** (pr-evidence skill)
- Extract facts-only evidence from PR diff
- Output: `<evidence_pack>` with changed files, code changes, design decisions

**Task 2: Requirements Extraction** (pr-requirements skill)
- Extract acceptance criteria from linked issue
- Output: `<requirements_pack>` with acceptance criteria and constraints

---

## Phase 3: Draft Technical Review

Compare evidence against requirements to produce draft review:

- **Coverage**: Does code address all requirements?
- **Correctness**: Are implementations appropriate?
- **Quality**: Code style, patterns, maintainability
- **Security**: Potential vulnerabilities

Apply evidence standards:
- Every technical claim requires a citation (file:line or quoted diff)
- Avoid "correctly", "validated", "confirmed" without [Basis: tests-run]
- No global quantifiers (always, never, ALL, ANY) without control-flow evidence

---

## Phase 4: Self-Audit

Spawn pr-audit skill to audit the draft review for:

1. Language violations (forbidden words without basis)
2. Missing citations
3. Speculation presented as fact
4. Quantifier violations
5. Terminology imprecision
6. Unrealistic test suggestions
7. Missing critical findings

---

## Phase 5: Finalize Review

Apply all required edits from audit and produce final review:

- Ensure all claims have proper citations and basis tags
- Verify actionable outcomes are concrete and prioritized
- Confirm merge recommendation has rationale

---

## Output Format

```xml
<final_review>
  <changed_files_ref>[List of changed files]</changed_files_ref>
  <requirements_ref>[List from requirements_pack or "Requirements not verified"]</requirements_ref>

  <summary>
    - [5-8 bullets describing what the PR does]
    - Key design decisions:
      - Decision 1 with citation [Basis: code-read]
      - Decision 2 with citation [Basis: code-read]
  </summary>

  <blockers>
    [Issues that must be fixed before merge, with citations and repros]
  </blockers>

  <non_blocking_suggestions>
    [Improvements that don't block merge]
  </non_blocking_suggestions>

  <test_gaps>
    [Missing test coverage with specific scenarios]
  </test_gaps>

  <actionable_outcomes>
    <task priority="P1" effort="S">
      <title>Short title</title>
      <why>Reason this matters</why>
      <files>Affected files</files>
      <change>Exact change to make</change>
    </task>
    [3-8 tasks total]
  </actionable_outcomes>

  <merge_recommendation>
    [APPROVE | REQUEST_CHANGES | COMMENT with rationale]
  </merge_recommendation>
</final_review>
```

---

## Evidence Standards

- Fetch PR diff and PR metadata. If fetch fails, state exactly what failed and continue with partial results.
- List changed files and ONLY reference those files (unless marked UNVERIFIED FILE REFERENCE).
- Every technical claim must include a citation (file+line OR quoted diff snippet OR GitHub permalink).
- If you assert "tests pass", your basis must be [Basis: tests-run]. Otherwise say "tests assert expected behavior" [Basis: code-read].

---

## Language Controls

Avoid these words unless immediately justified with evidence and a basis tag:
- "correctly", "validated", "confirmed", "high confidence", "mathematically sound"
- "safe", "robust", "prevents exploits", "blocks exploits"

If used, append: `[Basis: code-read | tests-run | proof | benchmark]` + citation.

**Critical**: If your basis is only code-read, you MUST NOT use "high confidence", "validated", "confirmed", "correctly", or "mathematically sound".

---

## Basis Tags

Always use one of these basis tags when making claims:
- `[Basis: code-read]` - Claim based on reading the code
- `[Basis: tests-run]` - Claim based on actually running tests
- `[Basis: proof]` - Claim based on mathematical proof
- `[Basis: benchmark]` - Claim based on performance measurement

---

## Priority Definitions

- **P1**: Must address before merge (blockers)
- **P2**: Should address soon, can be follow-up PR
- **P3**: Nice to have, low urgency

## Effort Definitions

- **S (Small)**: < 30 minutes, single file, straightforward
- **M (Medium)**: 1-4 hours, few files, some complexity
- **L (Large)**: > 4 hours, multiple files, significant changes

---

## Error Handling

- If PR fetch fails: State what failed and continue with partial data
- If issue not found: Proceed and note "Requirements not verified"
- If subagent fails: Record the error and continue with available data
- If comment posting fails: Report failure status

---

## Available Subagent Skills

| Skill | Purpose |
|-------|---------|
| `pr-evidence` | Extracts facts-only evidence from PR diff |
| `pr-requirements` | Extracts acceptance criteria from linked issue |
| `pr-audit` | Audits review for false positives and overstated claims |

When spawning agents via Task tool, include the input data they need (diff, issue URL, prior phase outputs).
