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
| design_classify | architecture-patterns |
| design_workflow | architecture-patterns |
| design_api | architecture-patterns |
| design_data | architecture-patterns |
| design_plan | architecture-patterns |
| design_review | architecture-patterns |
| design_edit | architecture-patterns |
| implement_task | test-driven-dev, frontend-design |
| task_spec_check | safe-shell-search, jeeves-task-spec-check, code-quality |
| code_review | code-quality, pr-review, pr-evidence, pr-requirements, pr-audit, differential-review |
| code_fix | code-quality |

### Layered Spec-Check Skills

The `task_spec_check` phase uses a layered skill architecture that separates reusable core guardrails from Jeeves-specific adapter logic:

| Order | Skill | Type | Purpose |
|-------|-------|------|---------|
| 1 | `safe-shell-search` | Core (common) | Enforces pruner-first codebase discovery/read and evidence-grounded claims. Replaces duplicated `<tooling_guidance>` blocks across prompts. |
| 2 | `jeeves-task-spec-check` | Adapter (implement) | Encodes Jeeves-specific MCP state contracts, `.jeeves/phase-report.json` and `task-feedback.md` artifact schemas, `filesAllowed` enforcement, and PASS/FAIL handling with structured criterion evidence. |
| 3 | `code-quality` | Review (common) | Generic code quality checklist (correctness, readability, maintainability, security). |

Skills are resolved in the order listed above. The core skill establishes search/evidence discipline, the adapter skill provides Jeeves-specific verification contracts, and the quality skill adds general review checks.

### Opt-In Rollout

Layered skill usage in `task_spec_check` is controlled by an opt-in feature flag:

- **Flag**: `issue.status.settings.useLayeredSkills` (boolean)
- **Default**: `false` (legacy mode)
- **Opt-in**: Set to `true` to enable layered mode

When layered mode is enabled, the workflow follows a four-phase spec-check flow:

1. **`spec_check_mode_select`** — Evaluates the rollout flag and verifies that both required layered skills (`safe-shell-search` and `jeeves-task-spec-check`) are discoverable and readable via root `AGENTS.md` metadata.
2. **`spec_check_layered`** — Runs the simplified spec-check prompt with layered skills providing operational guidance.
3. **`spec_check_persist`** — Commits status updates and produces canonical artifacts for workflow transition guards.

### Fallback Behavior

The system deterministically falls back to legacy mode (`spec_check_legacy`) when any of the following conditions hold:

- `status.settings.useLayeredSkills` is missing, `false`, or not a boolean.
- `status.settings.useLayeredSkills` is `true` but `status.layeredSkillAvailability.safeShellSearch` is not `true` (skill not found or `SKILL.md` unreadable).
- `status.settings.useLayeredSkills` is `true` but `status.layeredSkillAvailability.jeevesTaskSpecCheck` is not `true` (skill not found or `SKILL.md` unreadable).

Fallback is silent and non-blocking: the task loop continues in legacy mode with a warning logged to the progress event log. No run failure occurs due to missing or unreadable layered skills.

## Attribution

These skills are adapted from their original sources:

- **codex-skills**: Private repository (hansjm10/codex-skills)
- **differential-review**: [Trail of Bits](https://github.com/trailofbits/skills) (CC-BY-SA-4.0)
- **frontend-design**: [Anthropic](https://github.com/anthropics/skills) (MIT)

All skills have been adapted to follow the Jeeves SKILL.md format while preserving their core content and methodology.
