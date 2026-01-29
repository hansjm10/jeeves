---
name: differential-review
description: "Perform security-focused differential code review with git history analysis. Use for security audits of PRs/commits, detecting regressions, and vulnerability assessment. Triggers on: security review, differential review, security audit, vulnerability analysis, /differential-review."
---

# Differential Security Review

Security-focused code review for PRs, commits, and diffs. Adapted from Trail of Bits' security review methodology (CC-BY-SA-4.0).

---

## The Job

Perform comprehensive security-focused differential analysis of code changes:

1. **Triage**: Assess codebase size and classify risk level per file
2. **Analyze**: Deep review of changed code with git history context
3. **Coverage**: Check test coverage for changed security-critical code
4. **Blast Radius**: Calculate impact of changes (who calls what)
5. **Adversarial**: Model attack scenarios for HIGH risk changes
6. **Report**: Generate comprehensive security findings

---

## Invocation

```
/differential-review owner/repo#123
/differential-review HEAD~5..HEAD
/differential-review --commit abc123
```

---

## Severity Levels

| Level | Emoji | Description | Impact |
|-------|-------|-------------|--------|
| CRITICAL | RED | Immediate exploitation risk | Data loss, unauthorized access, fund theft |
| HIGH | ORANGE | Significant security impact | Privilege escalation, auth bypass, data exposure |
| MEDIUM | YELLOW | Notable security concern | Logic flaws, missing validation, weak controls |
| LOW | GREEN | Minor security improvement | Best practices, hardening, defense-in-depth |

---

## Risk Classification

### File Risk Triggers

| Risk Level | Triggers |
|------------|----------|
| HIGH | Authentication, authorization, cryptography, external calls, input validation removal, value transfer |
| MEDIUM | Business logic, state changes, new public APIs, configuration |
| LOW | Comments, tests, UI, logging, documentation |

### Codebase Size Strategy

| Size | Files | Strategy |
|------|-------|----------|
| SMALL | <20 | DEEP - Read all deps, full git blame |
| MEDIUM | 20-200 | FOCUSED - 1-hop deps, priority files |
| LARGE | 200+ | SURGICAL - Critical paths only |

---

## Security Checklist

### Input Handling

- [ ] All user inputs validated before use
- [ ] Input length limits enforced
- [ ] Special characters properly escaped/sanitized
- [ ] Type coercion handled safely
- [ ] Injection vectors checked (SQL, command, path)

### Authentication

- [ ] Authentication checks not removed or weakened
- [ ] Session handling secure
- [ ] Token validation complete
- [ ] Password/credential handling follows best practices
- [ ] Multi-factor authentication not bypassed

### Authorization

- [ ] Access control modifiers preserved (onlyOwner, internal, etc.)
- [ ] Permission checks not removed
- [ ] Privilege escalation paths analyzed
- [ ] Role-based access maintained
- [ ] Trust boundaries respected

### Data Protection

- [ ] Sensitive data not logged
- [ ] Encryption used appropriately
- [ ] Data exposure in error messages checked
- [ ] PII handling follows requirements
- [ ] Secrets not hardcoded

### State Management

- [ ] State updates follow expected order (CEI pattern)
- [ ] Concurrent access handled
- [ ] Invariants maintained
- [ ] Rollback scenarios covered
- [ ] Race conditions analyzed

---

## Git History Analysis Commands

### Extract Changes

```bash
# Commit range diff
git diff <base>..<head> --stat
git log <base>..<head> --oneline

# PR files via GitHub CLI
gh pr view <number> --json files,additions,deletions

# All changed files
git diff <base>..<head> --name-only
```

### Investigate Removed Code

```bash
# When was removed code added? Why?
git log -S "removed_code" --all --oneline
git blame <baseline> -- file.ext | grep "pattern"

# Check for regressions (code added, removed for security, re-added)
git log -S "added_code" --all -p
```

### Red Flag Detection

```bash
# Removed security checks
git diff <range> | grep "^-" | grep -E "require|assert|revert|check"

# Removed access control
git diff <range> | grep "^-.*onlyOwner"
git diff <range> | grep "^-.*onlyAdmin"

# New external calls
git diff <range> | grep "^+" | grep -E "\.call|\.delegatecall|exec|system"

# Changed visibility/access
git diff <range> | grep -E "internal|private|public|external"
```

### Blast Radius Calculation

```bash
# Count callers for modified function
grep -r "functionName(" --include="*.py" --include="*.ts" --include="*.sol" . | wc -l
```

| Callers | Blast Radius |
|---------|--------------|
| 1-5 | LOW |
| 6-20 | MEDIUM |
| 21-50 | HIGH |
| 50+ | CRITICAL |

---

## Common Vulnerability Patterns

### Security Regressions

Code previously removed for security reasons is re-added.

```bash
# Detect regressions
git log -S "pattern" --all --grep="security\|fix\|CVE"
```

**Red flags**: Commit message contains "security", "fix", "CVE", "vulnerability"

### Missing Validation

Removed `require`/`assert`/`check` without replacement.

```bash
git diff <range> | grep "^-.*require"
git diff <range> | grep "^-.*assert"
```

### Access Control Bypass

Removed or relaxed permission checks.

```bash
git diff <range> | grep "^-.*onlyOwner"
git diff <range> | grep "^-.*@requires_auth"
```

### Reentrancy Risk

External call before state update (CEI pattern violation).

### Unchecked Return Values

External calls without success verification.

---

## Adversarial Analysis (HIGH Risk Changes)

For each HIGH risk change, model the attacker:

### 1. Define Attacker Model

- **WHO**: Unauthenticated user, authenticated user, admin, compromised service
- **ACCESS**: What privileges/interfaces they have
- **GOAL**: What they want to achieve

### 2. Build Attack Scenario

```
ENTRY POINT: [Exact function/endpoint]
PRECONDITIONS: [Required state/privileges]
STEPS:
  1. [Specific action with parameters]
  2. [Expected outcome]
  3. [Exploitation achieved]
IMPACT: [Concrete harm - not theoretical]
```

### 3. Rate Exploitability

| Rating | Description |
|--------|-------------|
| EASY | Single call, public API, no special conditions |
| MEDIUM | Multiple steps, specific conditions, elevated privileges |
| HARD | Admin access, rare edge cases, significant resources |

---

## Report Template

```markdown
# Security Differential Review

## Executive Summary
| Severity | Count |
|----------|-------|
| CRITICAL | X |
| HIGH | Y |
| MEDIUM | Z |
| LOW | W |

**Recommendation**: APPROVE / REQUEST_CHANGES / BLOCK
**Confidence**: HIGH / MEDIUM / LOW

## What Changed
[Commit range, file summary, lines changed]

## Critical Findings
### [SEVERITY] Title
**File**: path/file.ext:lineNumber
**Blast Radius**: N callers (LEVEL)
**Description**: [Clear explanation]
**Attack Scenario**: [Concrete steps]
**Recommendation**: [Specific fix]

## Test Coverage Gaps
[Untested security-critical changes]

## Historical Context
[Security-related removals, regression risks]

## Analysis Methodology
[Strategy used, scope, limitations]
```

---

## Red Flags (Immediate Escalation)

These require adversarial analysis even in quick reviews:

- Removed code from commits mentioning "security", "CVE", "fix"
- Access control modifiers removed (onlyOwner, internal to external)
- Validation removed without replacement
- External calls added without checks
- High blast radius (50+ callers) + HIGH risk change

---

## Evidence Standards

- Every finding backed by file:line reference
- Git history context provided (when code was added, why)
- Attack scenarios are concrete, not generic
- Explicitly state analysis limitations and confidence level
- Basis tags for claims: `[Basis: code-read]`, `[Basis: tests-run]`

---

## When NOT to Use This Skill

- Greenfield code (no baseline to compare)
- Documentation-only changes
- Formatting/linting only
- User explicitly requests quick summary only

For these cases, use standard code-quality skill instead.

---

## Attribution

Based on Trail of Bits' differential-review skill from [trailofbits/skills](https://github.com/trailofbits/skills) (CC-BY-SA-4.0 license).
