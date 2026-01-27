---
title: Design Document Template
sidebar_position: 4
---

# Design Document Template

Use this template when authoring new design proposals or retrofitting existing notes. Fill out every section or state explicitly why it is not applicable. Replace bracketed guidance with project-specific detail before submitting for review. The structure is optimised for an AI-first delivery model where work is decomposed into issues and executed by autonomous agents under human orchestration.

## Document Control
- **Title**: _Concise, imperative summary (e.g., “Introduce deterministic command queue”)_
- **Authors**: _Name, squad_
- **Reviewers**: _Required approvers_
- **Status**: _Draft · In Review · Approved · Superseded_
- **Last Updated**: _YYYY-MM-DD_
- **Related Issues**: _Link to GitHub issues, PRs, or milestones_
- **Execution Mode**: _AI-led · Hybrid · Manual_

## 1. Summary
Provide a one-paragraph executive summary outlining the problem, proposed solution, and expected impact on the Idle Engine.

## 2. Context & Problem Statement
- **Background**: _Current behaviour, historical decisions, relevant metrics or incidents._
- **Problem**: _What is failing or missing today? Quantify with data or user feedback._
- **Forces**: _Constraints (performance targets, partner requirements, timelines)._

## 3. Goals & Non-Goals
- **Goals**: _Ordered list of measurable outcomes the design must achieve._
- **Non-Goals**: _Intentional exclusions to prevent scope creep._

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: _Teams or roles accountable for implementation._
- **Agent Roles**: _Describe autonomous/AI agents that will act on the plan and their responsibilities (e.g., “Docs Agent”, “Runtime Implementation Agent”)._
- **Affected Packages/Services**: _e.g., `packages/core`, `packages/content-schema`, `tools/content-schema-cli`._
- **Compatibility Considerations**: _Backward/forward compatibility, API stability promises._

## 5. Current State
Summarise the existing architecture, data flow, and operational characteristics. Reference source files, tests, and previous design decisions (link to sections within existing docs when possible).

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: _High-level description of how the solution operates._
- **Diagram**: _Embed or link to system diagrams when available._

### 6.2 Detailed Design
- **Runtime Changes**: _Execution model, command handling, state mutations._
- **Data & Schemas**: _New or modified schemas, migrations, validation rules._
- **APIs & Contracts**: _Public interfaces, message formats, content DSL extensions._
- **Tooling & Automation**: _CLI changes, build/lint/test updates._

### 6.3 Operational Considerations
- **Deployment**: _CI/CD updates, rollout strategy._
- **Telemetry & Observability**: _Metrics, logging, diagnostics timelines._
- **Security & Compliance**: _Threat model impacts, PII handling, permissions._

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
Populate the table as the canonical source for downstream GitHub issues.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| _e.g., “feat(core): add deterministic command queue”_ | _Implementation slice_ | _Runtime Implementation Agent_ | _Doc approval_ | _Unit tests updated; docs linked_ |

### 7.2 Milestones
- **Phase 1**: _Deliverables, timeline, gating criteria._
- **Phase 2**: _Subsequent increments and dependency alignment._

### 7.3 Coordination Notes
- **Hand-off Package**: _Source files, datasets, credentials, or context summarised for agent onboarding._
- **Communication Cadence**: _Status update frequency, review checkpoints, escalation path._

## 8. Agent Guidance & Guardrails
- **Context Packets**: _Key documents, environment variables, repositories agents must load before execution._
- **Prompting & Constraints**: _Canonical instruction snippets, required commit styles, naming conventions._
- **Safety Rails**: _Forbidden actions (e.g., “Do not reset git history”), data privacy requirements, rollback procedures._
- **Validation Hooks**: _Scripts or commands agents must run before marking a task complete._

## 9. Alternatives Considered
Document competing approaches, including why they were rejected. Highlight trade-offs (complexity, cost, risk) for future reference.

## 10. Testing & Validation Plan
- **Unit / Integration**: _New test suites, coverage expectations._
- **Performance**: _Benchmarks, profiling methodology, success thresholds._
- **Tooling / A11y**: _Playwright smoke coverage, vitest filters, manual QA._

## 11. Risks & Mitigations
Identify technical, operational, and organisational risks. Provide concrete mitigation steps or contingency plans.

## 12. Rollout Plan
- **Milestones**: _Phases with ownership and timelines._
- **Migration Strategy**: _Data migrations, feature flags, backwards compatibility._
- **Communication**: _Notes for release announcements, partner updates, runbooks._

## 13. Open Questions
Track unresolved items, blocked decisions, or data still required. Update this section as answers arrive.

## 14. Follow-Up Work
List tasks deferred out of scope (new tickets, technical debt paydown). Include owners and proposed timing.

## 15. References
- _Links to prior design docs, RFCs, ADRs, external research._
- _Relevant code paths (file and line references)._

## Appendix A — Glossary
Define domain-specific terminology, acronyms, and abbreviations introduced in the document.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| YYYY-MM-DD | Name   | _Initial draft / Update detail_ |

---

## Migration Playbook for Existing Documents

Use the following process to align historic documents with this template:

1. **Inventory & Prioritise**  
   - Catalogue every Markdown file under `docs/` and classify by workstream (runtime, content, tooling).  
   - Prioritise documents actively referenced during development or upcoming milestones.

2. **Gap Analysis**  
   - For each document, map content to the new sections. Note missing elements (e.g., explicit goals, testing strategy).

3. **Refactor**  
   - Create a working branch per document or cluster of related docs.  
   - Restructure the markdown to follow the template headings, preserving existing narrative while tightening language where repetitive.
   - Populate **Work Breakdown & Delivery Plan** and **Agent Guidance & Guardrails** to reflect the planned issue decomposition.

4. **Link & Cross-Reference**  
   - Add references to related specs, source files, and tests using the `References` and `Appendix` sections.  
   - Ensure Docusaurus sidebar categories remain accurate.

5. **Review & Approval**  
   - Route updated docs through the same review workflow as code changes.  
   - Capture reviewer feedback in the `Change Log` and update the issue map if scope changes.

6. **Rollout Tracking**  
   - Maintain a checklist (e.g., in the project board or a dedicated doc) to signal which documents have been migrated.  
   - Archive or supersede redundant documents once consolidated and close corresponding migration issues.

Adhering to this template keeps design history searchable, comparable, and ready for external review as the Idle Engine matures.
