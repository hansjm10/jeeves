---
title: Reorganize Repository Structure for Better Maintainability
sidebar_position: 5
---

# Reorganize Repository Structure for Better Maintainability

## Document Control
- **Title**: Reorganize repository structure for better maintainability
- **Authors**: Jeeves Agent
- **Reviewers**: Repository maintainers
- **Status**: Draft
- **Last Updated**: 2026-01-28
- **Related Issues**: [Issue #12](https://github.com/hansjm10/jeeves/issues/12)
- **Execution Mode**: AI-led

## 1. Summary

The Jeeves repository has grown organically and the root directory has become cluttered with prompt files, scripts, configuration examples, and state files. This design proposes reorganizing the repository into a clean, standard Python project layout with `src/jeeves/` as the core package, dedicated directories for prompts, scripts, tests, and examples. This will improve maintainability, developer experience, and align with Python packaging best practices.

## 2. Context & Problem Statement

- **Background**: Jeeves is an autonomous coding agent runner that has evolved over time. Files have been added to the root directory without a clear organizational strategy, resulting in a cluttered workspace.

- **Problem**: The current state includes:
  - 11 `prompt.issue.*.md` files at root level
  - Multiple standalone scripts (`init-issue.sh`, `create-issue-from-design-doc.sh`, `sonarcloud-issues.sh`, `jeeves.test.sh`)
  - A 76KB+ `jeeves.sh` bash CLI at root
  - Configuration examples and task files (`task-*.md`, `issue.json.example`)
  - State files that shouldn't be at root level (`last-run.log`, `metrics.jsonl`)
  - Tests mixed with source code inside `jeeves/` package
  - `viewer/` as a separate top-level package rather than integrated

- **Forces**:
  - Must maintain backward compatibility for existing users during transition
  - Python packaging standards recommend `src/` layout
  - CI/CD pipelines and import paths need updating
  - The `jeeves.sh` legacy script needs a deprecation strategy

## 3. Goals & Non-Goals

### Goals
1. Clean root directory with only essential files (README, LICENSE, pyproject.toml, CLAUDE.md/AGENTS.md)
2. Adopt standard `src/` Python layout for the package
3. Group all prompt templates under `prompts/` directory
4. Consolidate all scripts under `scripts/` directory
5. Move all tests to top-level `tests/` directory
6. Integrate `viewer/` into the main `src/jeeves/` package
7. Move examples and state files to appropriate locations
8. Update `pyproject.toml` and all imports to reflect new structure
9. Update documentation to reflect new structure

### Non-Goals
- Complete rewrite of `jeeves.sh` (only deprecation strategy needed)
- Changes to core functionality or APIs
- New features beyond reorganization
- Breaking changes to the CLI interface

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Repository maintainers, developers using Jeeves
- **Agent Roles**:
  - Jeeves Implementation Agent: Execute file moves, update imports, modify configuration
- **Affected Packages/Services**:
  - `jeeves/` (current) -> `src/jeeves/` (new)
  - `viewer/` -> `src/jeeves/viewer/`
  - All test files
  - `pyproject.toml`
  - CI/CD workflows in `.github/`
- **Compatibility Considerations**:
  - Entry points (`jeeves` CLI) must continue working
  - Import paths will change internally but CLI interface remains stable
  - `jeeves.sh` will be deprecated but kept as legacy wrapper initially

## 5. Current State

### Root Directory (cluttered)
```
jeeves/
├── README.md, LICENSE, pyproject.toml, CLAUDE.md, AGENTS.md
├── jeeves.sh (76KB+ bash CLI)
├── jeeves.test.sh
├── prompt.issue.*.md (11 files)
├── init-issue.sh, create-issue-from-design-doc.sh, sonarcloud-issues.sh
├── task-*.md, issue.json.example
├── last-run.log, metrics.jsonl
├── jeeves/                    # Python package (flat)
│   ├── __init__.py, cli.py, config.py, paths.py
│   ├── browse.py, issue.py, repo.py, worktree.py
│   ├── runner/                # Runner subpackage
│   ├── test_*.py (6 test files mixed with source)
│   ├── last-run.log, metrics.jsonl, current-run.json
│   └── viewer-run.log
├── viewer/                    # Separate package
│   ├── server.py, tui.py, index.html
│   └── test_server.py
├── docs/
└── skills/
```

### Key Issues
- Test files (`test_*.py`) mixed with source in `jeeves/`
- State/log files in multiple locations
- No clear separation between prompts, scripts, and configuration
- `viewer/` is isolated instead of integrated

## 6. Proposed Solution

### 6.1 Architecture Overview

**Narrative**: Restructure into a standard Python `src/` layout with clear separation of concerns. All source code under `src/jeeves/`, all tests under `tests/`, prompts and scripts in dedicated directories, and examples/configs in `examples/`.

**Target Structure**:
```
jeeves/
├── README.md
├── LICENSE
├── pyproject.toml
├── CLAUDE.md / AGENTS.md
│
├── src/jeeves/                 # Core Python package
│   ├── __init__.py
│   ├── cli.py                  # CLI entry point
│   ├── core/                   # Core logic
│   │   ├── __init__.py
│   │   ├── issue.py
│   │   ├── repo.py
│   │   ├── browse.py
│   │   ├── config.py
│   │   ├── paths.py
│   │   └── worktree.py
│   ├── runner/                 # Agent runners
│   │   ├── __init__.py
│   │   ├── config.py
│   │   ├── output.py
│   │   ├── sdk_runner.py
│   │   └── providers/
│   └── viewer/                 # Web viewer (moved here)
│       ├── __init__.py
│       ├── server.py
│       ├── tui.py
│       └── static/
│           └── index.html
│
├── prompts/                    # All prompt templates
│   ├── issue.ci.md
│   ├── issue.coverage.md
│   ├── issue.coverage.fix.md
│   ├── issue.design.md
│   ├── issue.implement.md
│   ├── issue.questions.md
│   ├── issue.review.md
│   ├── issue.sonar.md
│   ├── issue.task.implement.md
│   ├── issue.task.quality-review.md
│   └── issue.task.spec-review.md
│
├── scripts/                    # Helper scripts
│   ├── init-issue.sh
│   ├── create-issue-from-design-doc.sh
│   ├── sonarcloud-issues.sh
│   └── legacy/
│       ├── jeeves.sh          # Deprecated bash CLI
│       └── jeeves.test.sh
│
├── tests/                      # All tests in one place
│   ├── __init__.py
│   ├── test_browse.py
│   ├── test_browse_integration.py
│   ├── test_cli_browse.py
│   ├── test_issue.py
│   ├── test_recent.py
│   ├── test_repo.py
│   └── test_server.py
│
├── docs/                       # Documentation
│
├── examples/                   # Example configs
│   └── issue.json.example
│
└── skills/                     # Existing skills directory
```

### 6.2 Detailed Design

#### Runtime Changes
- CLI entry point changes from `jeeves.cli:main` to `jeeves.cli:main` (import path updated in pyproject.toml)
- Internal imports update to use `jeeves.core.*` for core modules
- Viewer imports update to use `jeeves.viewer.*`

#### Data & Schemas
- No schema changes required
- State files (`.runs/`, `current-run.json`) will be managed via `platformdirs` (already in use)

#### APIs & Contracts
- CLI interface remains unchanged
- Internal module imports change but are not public API

#### Tooling & Automation
- `pyproject.toml` updates:
  - Package location: `where = ["src"]`
  - Test paths: `testpaths = ["tests"]`
- CI workflows may need path updates

### 6.3 Operational Considerations

#### Deployment
- No special deployment changes needed
- `pip install` will work with new structure

#### Telemetry & Observability
- Log file locations should use `platformdirs` consistently
- Remove hardcoded log files from package directories

#### Security & Compliance
- No security implications
- No PII handling changes

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| Create src/jeeves directory structure | Set up new directory layout with core/ subpackage | Jeeves Agent | None | Directories created, __init__.py files in place |
| Move core modules to src/jeeves/core | Relocate issue.py, repo.py, browse.py, config.py, paths.py, worktree.py | Jeeves Agent | T1 | Files moved, imports updated within files |
| Move runner to src/jeeves/runner | Relocate runner subpackage | Jeeves Agent | T1 | Runner functional with new paths |
| Move viewer to src/jeeves/viewer | Integrate viewer package into main package | Jeeves Agent | T1 | Viewer functional, static files accessible |
| Move CLI to src/jeeves | Relocate cli.py, update imports | Jeeves Agent | T2, T3, T4 | CLI commands work correctly |
| Move prompts to prompts/ directory | Relocate all prompt.issue.*.md files, rename to remove prefix | Jeeves Agent | None | Prompts accessible, code references updated |
| Move scripts to scripts/ directory | Relocate shell scripts, organize legacy | Jeeves Agent | None | Scripts functional from new location |
| Move tests to tests/ directory | Consolidate all test_*.py files | Jeeves Agent | T2, T3, T4, T5 | Tests pass from new location |
| Move examples and clean root | Move issue.json.example, remove state files from root | Jeeves Agent | None | Root contains only essential files |
| Update pyproject.toml | Update package config for src layout, entry points, test paths | Jeeves Agent | T1-T8 | pip install works, CLI works, tests run |
| Update documentation | Update README, CLAUDE.md, AGENTS.md with new structure | Jeeves Agent | T10 | Docs reflect new structure |
| Validate and integration test | Run full test suite, verify CLI, verify imports | Jeeves Agent | T1-T11 | All tests pass, no import errors |

### 7.2 Milestones

- **Phase 1**: Core restructure (T1-T5) - Create src layout, move Python code
- **Phase 2**: Supporting files (T6-T9) - Move prompts, scripts, tests, examples
- **Phase 3**: Configuration & docs (T10-T11) - Update pyproject.toml, documentation
- **Phase 4**: Validation (T12) - Integration testing, verification

### 7.3 Coordination Notes

- **Hand-off Package**: Current directory listings, pyproject.toml, import analysis
- **Communication Cadence**: Progress updates after each phase completion
- **Risks**: Import path updates may be missed in some files; mitigated by comprehensive grep and test execution

## 8. Agent Guidance & Guardrails

- **Context Packets**:
  - Current file structure (documented above)
  - pyproject.toml configuration
  - Import patterns in existing code

- **Prompting & Constraints**:
  - Use `git mv` for file moves to preserve history
  - Update imports using find-and-replace patterns
  - Maintain `__init__.py` files in all packages
  - Keep backward-compatible CLI interface

- **Safety Rails**:
  - Do not delete `jeeves.sh` - move to `scripts/legacy/`
  - Do not modify core logic, only move and update imports
  - Run tests after each major move operation
  - Do not reset git history

- **Validation Hooks**:
  - `python -c "import jeeves"` - verify package imports
  - `pytest tests/` - run test suite
  - `jeeves --help` - verify CLI works

## 9. Alternatives Considered

1. **Keep flat structure, just organize root**: Rejected because it doesn't address test/source mixing or standard Python layout benefits.

2. **Use namespace packages**: Rejected as overly complex for this project size.

3. **Monorepo with multiple packages**: Rejected because viewer and runner are tightly coupled to core.

4. **Delete jeeves.sh entirely**: Rejected to maintain backward compatibility; deprecation is safer.

## 10. Testing & Validation Plan

- **Unit / Integration**:
  - All existing tests must pass after restructure
  - Import paths verified via test execution
  - Expected coverage to remain same or improve

- **Performance**:
  - No performance testing needed (structural change only)

- **Tooling**:
  - Verify `pip install -e .` works
  - Verify `jeeves` CLI command works
  - Verify `pytest` discovers all tests

## 11. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Missed import updates | Medium | High | Comprehensive grep for all import patterns; run tests |
| CI/CD pipeline breaks | Medium | Medium | Update workflow files as part of implementation |
| External users with hardcoded paths | Low | Medium | Document changes clearly; keep CLI interface stable |
| State file location confusion | Low | Low | Use platformdirs consistently |

## 12. Rollout Plan

- **Milestones**:
  - Phase 1: Core restructure (T1-T5)
  - Phase 2: Supporting files (T6-T9)
  - Phase 3: Config & docs (T10-T11)
  - Phase 4: Validation (T12)

- **Migration Strategy**:
  - All changes in single PR for atomic transition
  - No feature flags needed (structural change)
  - `jeeves.sh` kept as deprecated legacy wrapper

- **Communication**:
  - PR description will detail all changes
  - README update will document new structure
  - AGENTS.md update for agent context

## 13. Open Questions

1. Should `jeeves.sh` be completely removed in a future release, or maintained indefinitely as a wrapper?
2. Are there any external integrations that rely on specific file paths that we need to account for?
3. Should prompt files be loadable as Python package resources or kept as external files?

## 14. Follow-Up Work

- Remove `jeeves.sh` entirely in a future release (after deprecation period)
- Consider adding `py.typed` marker for type checking support
- Evaluate adding pre-commit hooks for code quality

## 15. References

- [Issue #12](https://github.com/hansjm10/jeeves/issues/12) - Original issue with proposed structure
- [Python Packaging Guide - src layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/)
- Current `pyproject.toml` configuration
- Existing test files in `jeeves/test_*.py`

## Appendix A - Glossary

- **src layout**: Python packaging convention where source code lives under `src/` directory
- **platformdirs**: Python library for platform-specific directories (config, data, cache)
- **Entry point**: CLI command defined in pyproject.toml that maps to a Python function

## Appendix B - Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-28 | Jeeves Agent | Initial draft |
