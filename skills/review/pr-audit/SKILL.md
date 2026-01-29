---
name: pr-audit
description: "Audit PR reviews for false positives, overstated claims, and unsubstantiated assertions. Triggers on: /pr-audit, audit review, check review, find false positives, verify claims, validate review."
---

# PR Review Auditor

Evaluate whether a PR review's claims are justified by evidence. This skill audits reviews for quality and accuracy, not the PR itself.

---

## The Job

Audit a PR review to find false positives, overstated claims, and assertions without evidence. This does NOT re-review the PR; it evaluates whether the review's claims are supported.

**Key Principle**: Absence of evidence = classify as [Overstated] or [Unsubstantiated], not [Correct].

---

## Invocation

```
/pr-audit                         # Prompts for review text
/pr-audit --with-diff             # Also provide PR diff for verification
```

---

## Audit Checklist

### 1. Evidence Standard

- If review references specific code behavior, lines, or files, it must be supported by the PR diff
- If no diff provided, mark such claims "Not verifiable" rather than "false" (unless internally inconsistent)

### 2. False Positive Definition

A "false positive" is any of:
- Claim incorrect given provided evidence
- Claim presented as fact but not supported by evidence
- Overconfident phrasing without proof
- Speculation masquerading as certainty
- Logical error or mismatch between evidence and conclusion

### 3. Confidence-Language Violations

Flag as [Overstated] unless directly supported by cited code evidence:
- "correctly", "validated", "confirmed"
- "applied consistently", "high confidence"
- "fundamentally sound", "mathematically sound"
- "safe", "robust", "secure"
- "fully prevents", "guarantees", "blocks exploits"

### 4. Fairness

- If claim might be true but isn't supported, label "Unsubstantiated" (not "Incorrect")
- Use precise language: "unverified", "overstated", "speculative", "missing evidence", "internally inconsistent"

### 5. Actionability

For every false-positive candidate, propose:
1. A tighter, defensible rewrite
2. The exact evidence needed to validate the original claim

---

## Process

1. **List strongest confidence statements** from the review
2. **Check each for evidence support** (citations, code snippets, test results)
3. **Audit each blocker**:
   - Is it actually blocking given stated requirements?
   - Does repro logically demonstrate the issue?
   - Does proposed fix address the stated problem?
4. **Check for internal contradictions** (e.g., claiming consistency then noting inconsistencies)

---

## Classification Guide

| Classification | When to Use |
|---------------|-------------|
| **Incorrect** | Claim contradicted by provided evidence |
| **Unsubstantiated** | Claim might be true but no evidence supports it |
| **Overstated** | Claim uses confidence language without sufficient basis |
| **Speculative** | Claim about potential issues without concrete repro |
| **Internally inconsistent** | Claim contradicts other claims in the same review |

---

## Output Format

Produce an `audit_report` XML artifact:

```xml
<audit_report>
  <audit_summary>
    - [3-6 bullets on: overall reliability, degree of overconfidence, most serious false-positive risks]
  </audit_summary>

  <false_positive_candidates>
    <item>
      <claim>[Exact quote from review]</claim>
      <classification>[Incorrect | Unsubstantiated | Overstated | Speculative | Internally inconsistent]</classification>
      <why>
        - [1-3 bullets explaining the issue]
      </why>
      <evidence_check>[Cite diff snippet or "No diff provided"]</evidence_check>
      <better_phrasing>[Conservative rewrite]</better_phrasing>
      <what_to_ask_for>[Exact file/line/snippet needed to verify]</what_to_ask_for>
    </item>
  </false_positive_candidates>

  <blocker_sanity_check>
    <blocker>
      <claim>[Blocker from review]</claim>
      <truly_blocking>[Yes | No | Unclear]</truly_blocking>
      <verification_status>[Verified | Not verifiable | Contradicted]</verification_status>
      <notes>[Tight, factual notes]</notes>
    </blocker>
  </blocker_sanity_check>

  <missing_context_requests>
    - [Minimal list of PR snippets required to verify disputed claims]
    - [Prioritize correctness and exploit-related claims]
  </missing_context_requests>

  <cleaned_review_snippet>
    [Rewrite of the review's summary section with:
     - No unverifiable certainty
     - No global correctness claims
     - Explicit uncertainty where appropriate]
  </cleaned_review_snippet>
</audit_report>
```

---

## Examples

### Example 1: Overstated Claim

**Input claim**: "Guard conditions: Input/output amounts validated as positive, ratios validated as finite, epsilon threshold (1e-8) applied consistently"

**Audit**:
- Classification: Overstated
- Why:
  - Multiple factual assertions bundled into one statement
  - "Applied consistently" is a global claim requiring proof across all code paths
- Better phrasing: "I see positive/finiteness checks in the cycle-analysis path shown, but I haven't verified all ratio comparisons use EPS consistently."
- Ask for: "Paste all ratio comparison sites (profit detection + cycle validation) to verify EPS usage."

### Example 2: Unsubstantiated Claim

**Input claim**: "Correctly uses N iterations of Bellman-Ford to detect negative-weight cycles"

**Audit**:
- Classification: Unsubstantiated
- Why:
  - "Correctly" implies validation of iteration count, initialization, and termination
  - No supporting code cited
- Better phrasing: "Implements a Bellman-Ford-style relaxation loop; iteration count and cycle reconstruction need confirmation."
- Ask for: "findNetPositiveCycle implementation including loop bounds and predecessor handling."

---

## Integration with PR Review Workflow

This skill is typically invoked during Phase 4 of the pr-review workflow to self-audit draft reviews before finalization. It helps ensure:

- Reviews don't make unsupported claims
- Blockers are truly blocking
- Language matches the evidence basis
- No false confidence is conveyed
