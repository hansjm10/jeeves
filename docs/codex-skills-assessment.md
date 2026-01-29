# Codex-Skills Assessment

## Repository Access

**Status:** Successfully cloned
**Repository:** hansjm10/codex-skills
**Clone Date:** 2025-01-29

---

## Available Skills

| Skill | Path | Description |
|-------|------|-------------|
| pr-review | `/pr-review/SKILL.md` | Orchestrated PR review workflow with evidence-based, audited reviews |
| pr-evidence | `/pr-evidence/SKILL.md` | Extract factual evidence from PR diffs without interpretation |
| pr-requirements | `/pr-requirements/SKILL.md` | Extract acceptance criteria from GitHub issues |
| pr-audit | `/pr-audit/SKILL.md` | Audit PR reviews for false positives and overstated claims |
| sonarqube | `/sonarqube/SKILL.md` | SonarQube/SonarCloud API access for quality gate data |
| pr-review-comment | `/pr-review-comment/SKILL.md` | Convert XML review to Markdown and post as GitHub comment |
| pr-review-summary | `/pr-review-summary/SKILL.md` | Generate plain-text summary from review XML |

### Reference Files (pr-review)

- `pr-review/references/global-rules.md` - Language controls, citation requirements, basis tags
- `pr-review/references/phases.md` - Detailed output formats for each phase
- `pr-review/references/examples.md` - Good/bad examples and priority/effort definitions

### Scripts

- `pr-review-comment/scripts/post_comment.py` - Python script to post comments to GitHub

---

## Skill Format Analysis

### Codex-Skills Format

```yaml
---
name: skill-name
description: |
  Short description of the skill.
  Use when: (1) trigger condition, (2) another trigger, (3) third trigger.
  Additional context about output format or behavior.
---
```

**Content Structure:**
- Main heading (`# Skill Title`)
- Invocation section with command examples
- Purpose/workflow description
- Process steps with numbered sub-steps
- Output format (often XML)
- Rules/guidelines
- Examples (where applicable)
- No explicit `---` section separators

### Jeeves SKILL.md Format

```yaml
---
name: skill-name
description: "Description with triggers. Triggers on: keyword1, keyword2, keyword3."
---
```

**Content Structure:**
- Main heading (`# Skill Title`)
- Brief intro paragraph
- `---` separator
- `## The Job` section
- `---` separator
- `## Output Format` or other sections
- `---` separator
- Additional sections as needed

---

## Compatibility Assessment

### Already Compatible

1. **YAML Frontmatter**: Both formats use identical frontmatter structure:
   - `name`: Required, string
   - `description`: Required, string with trigger phrases

2. **Trigger Phrases**: Both include trigger information in description:
   - Codex: "Use when: (1)..., (2)..., (3)..."
   - Jeeves: "Triggers on: keyword1, keyword2, keyword3"

3. **Markdown Content**: Both use standard Markdown with headers and code blocks

### Adaptations Needed

| Aspect | Codex Format | Jeeves Format | Adaptation Required |
|--------|--------------|---------------|---------------------|
| Section separators | None | `---` between sections | Add `---` separators |
| Trigger phrase style | "Use when: (1)..." | "Triggers on: ..." | Convert to Jeeves style |
| Content sections | Free-form | "The Job", "Output Format" | Reorganize into Jeeves sections |
| XML output | Detailed XML schemas | Less common | Keep as-is (compatible) |

### Minimal Changes Required

1. **Add Section Separators**: Insert `---` between major sections
2. **Adapt Trigger Phrase Format**:
   - From: `Use when: (1) User runs /skill, (2) User asks to do X`
   - To: `Triggers on: /skill, do X, extract Y`
3. **Optional Section Reorganization**: Can keep original structure as long as separators are added

---

## Integration Priority

Based on design document requirements:

### Phase 1: PR Review Skills (Tasks T2-T5)
1. **pr-review** - Main orchestrator skill
2. **pr-evidence** - Evidence extraction
3. **pr-requirements** - Requirements extraction
4. **pr-audit** - Self-audit capability

### Phase 2: Code Quality (Task T6)
5. **sonarqube** - SonarQube/SonarCloud integration

### External Skills (Tasks T7-T8)
6. **differential-review** (from trailofbits/skills) - Security review
7. **frontend-design** (from anthropics/skills) - UI design patterns

---

## Skill Relationships

```
pr-review (orchestrator)
├── pr-evidence (Phase 1 - parallel)
├── pr-requirements (Phase 2 - parallel)
├── pr-audit (Phase 4 - sequential)
├── pr-review-comment (Phase 6/7 - optional)
└── pr-review-summary (Phase 8 - final)
```

The pr-review skill is an orchestrator that:
- Spawns pr-evidence and pr-requirements in parallel (Task tool)
- Waits for both, then drafts review
- Spawns pr-audit to self-audit
- Finalizes and optionally posts comment

---

## Notes for Integration

1. **Reference Files**: The `pr-review/references/` directory contains important supplementary content. Consider:
   - Embedding key rules directly in adapted skill, OR
   - Including as separate reference docs

2. **Scripts**: The `post_comment.py` script is referenced but may not be needed if using `gh pr comment` directly

3. **Agent Architecture**: pr-review references subagents (`pr-evidence`, `pr-requirements`, `pr-audit`) via Task tool. In Jeeves:
   - These can be standalone skills
   - Or integrated into a single comprehensive skill

4. **XML Artifacts**: The workflow produces XML artifacts for structured data passing between phases. This pattern can be preserved in Jeeves.
