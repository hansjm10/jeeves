---
name: pr-evidence
description: "Extract factual evidence from PR diffs without interpretation or judgment. Triggers on: /pr-evidence, extract evidence, PR facts, diff summary, what changed."
---

# PR Evidence Extractor

Build a facts-only evidence pack from a PR diff. This skill extracts structured factual data without opinions, recommendations, or evaluation.

---

## The Job

Extract factual evidence from a PR diff and produce a structured `evidence_pack` artifact that can be used by other skills (pr-review) or for documentation.

**Key Principle**: Facts only. Describe what changed, not whether it's good or bad.

---

## Invocation

```
/pr-evidence owner/repo#123
/pr-evidence https://github.com/owner/repo/pull/123
/pr-evidence 123                  # Uses current repo
```

Or provide diff directly when prompted.

---

## Process

### Step 1: Fetch PR Diff

```bash
gh pr diff {pr_number} --repo {owner}/{repo}
```

### Step 2: Analyze Changed Files

For each file in the diff:
- File path
- Change type (added/modified/deleted)
- Lines added/removed
- File category (source, test, docs, config, etc.)

### Step 3: Extract Key Code Changes

For each significant code change:
- File path and line numbers
- What was added/modified/removed (factual description)
- No interpretation of intent or quality

### Step 4: Observe Design Decisions

Look for observable patterns (not inferred intent):
- Constants and thresholds introduced
- Error handling patterns used
- Early returns or guard conditions
- Algorithm choices (name the technique, don't evaluate)
- Scope restrictions or exclusions

### Step 5: Catalog Test Changes

For each test file:
- Test name/description
- What scenario it tests
- Fixtures added or modified

### Step 6: Catalog Doc Changes

For each documentation file:
- Section modified
- Content added/removed

---

## Output Format

Produce an `evidence_pack` XML artifact:

```xml
<evidence_pack>
  <changed_files>
    <file>
      <path>src/feature.ts</path>
      <type>modified</type>
      <additions>50</additions>
      <deletions>20</deletions>
    </file>
  </changed_files>

  <key_code_changes>
    <change>
      <location>src/feature.ts:42-60</location>
      <description>Added function validateInput that checks for null and returns early</description>
    </change>
    <change>
      <location>src/feature.ts:100</location>
      <description>Changed THRESHOLD constant from 0.01 to 0.001</description>
    </change>
  </key_code_changes>

  <key_design_decisions_observed>
    <decision>
      <pattern>Early return on invalid input</pattern>
      <location>src/feature.ts:45</location>
    </decision>
    <decision>
      <pattern>Uses Bellman-Ford algorithm for cycle detection</pattern>
      <location>src/graph.ts:120-180</location>
    </decision>
  </key_design_decisions_observed>

  <tests_changed>
    <test>
      <file>tests/feature.test.ts</file>
      <description>Added test "handles null input gracefully"</description>
    </test>
    <test>
      <file>tests/fixtures.ts</file>
      <description>Added fixture invalidInputFixture with null values</description>
    </test>
  </tests_changed>

  <docs_changed>
    <doc>
      <file>README.md</file>
      <description>Updated "Configuration" section with new threshold parameter</description>
    </doc>
  </docs_changed>

  <notable_constants_and_thresholds>
    <constant>
      <name>THRESHOLD</name>
      <value>0.001</value>
      <location>src/feature.ts:10</location>
    </constant>
    <constant>
      <name>MAX_ITERATIONS</name>
      <value>100</value>
      <location>src/graph.ts:15</location>
    </constant>
  </notable_constants_and_thresholds>
</evidence_pack>
```

---

## Rules

1. **Facts only**: Describe what changed, not whether it's good or bad
2. **No interpretation**: Don't infer intent beyond what's observable
3. **Cite everything**: Every claim needs a file:line reference
4. **Complete coverage**: Include all significant changes, not just interesting ones
5. **Structured output**: Use consistent XML format for downstream processing

---

## What to Include

- All file changes with statistics
- Function/class additions and modifications
- Constant and threshold values
- Algorithm implementations (name the technique)
- Test scenarios added/modified
- Documentation updates
- Configuration changes

---

## What NOT to Include

- Opinions on code quality
- Recommendations or suggestions
- Speculation about intent
- Evaluation of correctness
- Comparisons to alternatives
