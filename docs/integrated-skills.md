# Integrated External Skills

This document describes the external skills integrated into Jeeves for enhanced code review, security analysis, code quality checks, and frontend design capabilities.

## Overview

Jeeves has integrated high-quality skills from three sources:

| Source | Skills Integrated | License |
|--------|------------------|---------|
| [hansjm10/codex-skills](https://github.com/hansjm10/codex-skills) | pr-review, pr-evidence, pr-requirements, pr-audit, sonarqube | Private |
| [trailofbits/skills](https://github.com/trailofbits/skills) | differential-review | CC-BY-SA-4.0 |
| [anthropics/skills](https://github.com/anthropics/skills) | frontend-design | MIT |

## Skill Catalog

### PR Review Skills

These skills provide an evidence-based, multi-phase approach to pull request reviews.

#### pr-review (Orchestrator)

**Location**: `skills/review/pr-review/SKILL.md`
**Phase**: `code_review`
**Source**: codex-skills

Orchestrates a complete PR review pipeline with evidence extraction, requirements matching, and self-auditing.

**Workflow Phases**:
1. **Fetch** - Retrieve PR metadata and diff
2. **Evidence** - Extract factual changes (via pr-evidence)
3. **Requirements** - Match to acceptance criteria (via pr-requirements)
4. **Review** - Evaluate implementation quality
5. **Audit** - Self-check for false positives (via pr-audit)
6. **Finalize** - Produce publishable review

**Invocation**:
```
/pr-review owner/repo#123
/pr-review 123                    # Uses current repo
/pr-review 123 --post-comment     # Post comment after review
```

**Key Features**:
- Evidence-based claims with citations
- Basis tags for confidence levels (`[Basis: code-read]`, `[Basis: tests-run]`)
- Structured XML output with actionable tasks
- Priority (P1/P2/P3) and effort (S/M/L) ratings

---

#### pr-evidence

**Location**: `skills/review/pr-evidence/SKILL.md`
**Phase**: `code_review`
**Source**: codex-skills

Extracts factual evidence from PR diffs without interpretation or judgment.

**Invocation**:
```
/pr-evidence owner/repo#123
/pr-evidence 123
```

**Output**: `<evidence_pack>` XML with:
- Changed files with statistics
- Key code changes with locations
- Observable design decisions
- Test and documentation changes
- Notable constants and thresholds

**Key Principle**: Facts only. Describes what changed, not whether it's good or bad.

---

#### pr-requirements

**Location**: `skills/review/pr-requirements/SKILL.md`
**Phase**: `code_review`
**Source**: codex-skills

Extracts acceptance criteria from GitHub issues for evidence-based review.

**Invocation**:
```
/pr-requirements owner/repo#123
/pr-requirements 123
```

**Output**: `<requirements_pack>` XML with:
- Issue reference and title
- Numbered acceptance criteria with sources
- Constraints and non-goals
- Identified ambiguities

**Key Principle**: Extract what's there. Don't invent requirements.

---

#### pr-audit

**Location**: `skills/review/pr-audit/SKILL.md`
**Phase**: `code_review`
**Source**: codex-skills

Audits PR reviews for false positives, overstated claims, and unsubstantiated assertions.

**Invocation**:
```
/pr-audit                         # Prompts for review text
/pr-audit --with-diff             # Also provide PR diff for verification
```

**Output**: `<audit_report>` XML with:
- False positive candidates with classifications
- Blocker sanity checks
- Suggested rewrites for problematic claims
- Missing context requests

**Classifications**:
- **Incorrect**: Claim contradicted by evidence
- **Unsubstantiated**: Claim might be true but no evidence
- **Overstated**: Confidence language without sufficient basis
- **Speculative**: Potential issues without concrete repro
- **Internally inconsistent**: Self-contradicting claims

---

### Security Review

#### differential-review

**Location**: `skills/review/differential-review/SKILL.md`
**Phase**: `code_review`
**Source**: Trail of Bits (CC-BY-SA-4.0)

Security-focused differential code review with git history analysis.

**Invocation**:
```
/differential-review owner/repo#123
/differential-review HEAD~5..HEAD
/differential-review --commit abc123
```

**Security Checklist**:
- Input handling (validation, sanitization, injection)
- Authentication (checks, session handling, credentials)
- Authorization (access control, privilege escalation)
- Data protection (encryption, PII, secrets)
- State management (CEI pattern, concurrency, invariants)

**Severity Levels**:
| Level | Description | Examples |
|-------|-------------|----------|
| CRITICAL | Immediate exploitation risk | SQL injection, RCE |
| HIGH | Significant security impact | Auth bypass, data exposure |
| MEDIUM | Notable security concern | Logic flaws, missing validation |
| LOW | Minor security improvement | Best practices, hardening |

**Red Flags** (require immediate attention):
- Removed code from security-related commits
- Access control modifiers removed
- Validation removed without replacement
- External calls added without checks
- High blast radius + HIGH risk change

---

### Code Quality

#### sonarqube

**Location**: `skills/common/sonarqube/SKILL.md`
**Phase**: Common (all phases)
**Source**: codex-skills

Access SonarQube/SonarCloud API for code quality metrics and issue data.

**Environment Variables**:
```bash
SONAR_TOKEN=your_token_here
SONAR_HOST_URL=https://sonarcloud.io  # Optional
```

**Common Operations**:
```bash
# Quality gate status
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/qualitygates/project_status?projectKey=<key>&pullRequest=<pr>"

# Issues for PR
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?projectKeys=<key>&pullRequest=<pr>"

# Leak-period issues
curl -sSf -u "$SONAR_TOKEN:" \
  "$SONAR_HOST_URL/api/issues/search?componentKeys=<key>&sinceLeakPeriod=true"
```

**Issue Categories**:
| Type | Description | Priority |
|------|-------------|----------|
| BUG | Demonstrably wrong code | High |
| VULNERABILITY | Security-sensitive code | High |
| CODE_SMELL | Maintainability issues | Medium |

**Integration with Jeeves**:
Set `status.sonarClean = true` when quality gate passes and no new issues exist.

---

### Frontend Design

#### frontend-design

**Location**: `skills/implement/frontend-design/SKILL.md`
**Phase**: `implement_task`
**Source**: Anthropic (MIT)

Create distinctive, production-grade frontend interfaces avoiding generic "AI slop" aesthetics.

**Invocation**:
```
/frontend-design
```

**Design Philosophy**:
- **Avoid**: Generic fonts (Inter, Roboto), purple gradients, predictable layouts
- **Instead**: Intentional choices that feel genuinely designed for the context

**Tone Options**:
- Brutally minimal
- Maximalist chaos
- Retro-futuristic
- Organic/natural
- Luxury/refined
- Playful/toy-like
- Editorial/magazine
- Brutalist/raw
- Art deco/geometric
- Soft/pastel
- Industrial/utilitarian

**Key Systems**:
- Typography system with distinctive font pairings
- Color system with CSS custom properties
- Spacing system for consistent rhythm
- Motion design for high-impact moments
- Component patterns with personality

---

## Phase Mappings

Skills are automatically provisioned based on workflow phase:

| Phase | Skills |
|-------|--------|
| All phases | jeeves, progress-tracker, sonarqube |
| design_draft | architecture-patterns |
| design_review | architecture-patterns |
| design_edit | architecture-patterns |
| implement_task | test-driven-dev, frontend-design |
| task_spec_check | code-quality |
| code_review | code-quality, pr-review, pr-evidence, pr-requirements, pr-audit, differential-review |
| code_fix | code-quality |

## Attribution

These skills are adapted from their original sources:

- **codex-skills**: Private repository (hansjm10/codex-skills)
- **differential-review**: [Trail of Bits](https://github.com/trailofbits/skills) (CC-BY-SA-4.0)
- **frontend-design**: [Anthropic](https://github.com/anthropics/skills) (MIT)

All skills have been adapted to follow the Jeeves SKILL.md format while preserving their core content and methodology.
