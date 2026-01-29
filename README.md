# Jeeves

**SDK-only agent runner with a real-time viewer**

Jeeves is a proof‑of‑concept orchestration layer that runs a Claude Agent SDK session and streams structured output to a web dashboard. The viewer is the primary interface: it initializes issues, manages worktrees, launches runs, and shows logs and SDK events in real time.

## Quick Start

### Prerequisites

- Python 3.10+
- `gh` CLI (optional, for GitHub issue metadata)
- Claude Agent SDK (`pip install claude-agent-sdk`)

### Install

```bash
pip install -e .
```

### Start the viewer

```bash
python -m jeeves.viewer.server
# open http://localhost:8080
```

## Viewer Workflow

1. **Init Issue** (Setup tab) – clone repo, create issue state, and create worktree.
2. **Choose Phase** – Design, Implement, Review, or Complete.
3. **Run** – launches the SDK runner and streams logs + SDK events.
4. **Edit Prompts** – edit `prompts/issue.*.md` in the Prompts tab.

## State Directory (XDG)

Jeeves stores state in the XDG data directory (override with `JEEVES_DATA_DIR`).

Typical layout:

```
~/.local/share/jeeves/
├── repos/
├── worktrees/
├── issues/
│   └── owner/repo/123/
│       ├── issue.json
│       ├── progress.txt
│       ├── last-run.log
│       ├── viewer-run.log
│       └── sdk-output.json
```

## Minimal issue.json schema

```json
{
  "schemaVersion": 1,
  "repo": "owner/repo",
  "issue": { "number": 42, "title": "Example issue", "url": "..." },
  "branch": "issue/42-example",
  "phase": "design",
  "designDocPath": "docs/issue-42-design.md",
  "notes": ""
}
```

## Skills

Jeeves uses a phase-based skill provisioning system that provides contextual guidance during different workflow phases. Skills are markdown files with YAML frontmatter that get copied to `.claude/skills/` before each phase.

### Integrated External Skills

Jeeves includes high-quality skills adapted from external sources:

| Skill | Purpose | Source |
|-------|---------|--------|
| **pr-review** | Evidence-based PR review orchestration with self-audit | codex-skills |
| **pr-evidence** | Extract factual evidence from diffs | codex-skills |
| **pr-requirements** | Extract acceptance criteria from issues | codex-skills |
| **pr-audit** | Audit reviews for false positives | codex-skills |
| **sonarqube** | SonarQube/SonarCloud API integration | codex-skills |
| **differential-review** | Security-focused code review | [Trail of Bits](https://github.com/trailofbits/skills) |
| **frontend-design** | Production-grade UI design guidance | [Anthropic](https://github.com/anthropics/skills) |

### Phase Mappings

| Phase | Skills Provisioned |
|-------|-------------------|
| All phases | jeeves, progress-tracker, sonarqube |
| design_* | architecture-patterns |
| implement_task | test-driven-dev, frontend-design |
| code_review | code-quality, pr-review, pr-evidence, pr-requirements, pr-audit, differential-review |

See [docs/integrated-skills.md](docs/integrated-skills.md) for detailed skill documentation.

## Repository Structure

```
jeeves/
├── src/jeeves/                  # Core Python package
│   ├── core/                    # GitHub + worktree helpers
│   ├── runner/                  # SDK runner
│   └── viewer/                  # Web dashboard
├── skills/                      # Skill definitions (SKILL.md files)
│   ├── common/                  # Skills for all phases
│   ├── design/                  # Design phase skills
│   ├── implement/               # Implementation phase skills
│   ├── review/                  # Code review skills
│   └── registry.yaml            # Phase-to-skill mappings
├── prompts/                     # Prompt templates
├── scripts/                     # Helper scripts
├── tests/                       # Test suite
└── examples/                    # Example configurations
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JEEVES_DATA_DIR` | `~/.local/share/jeeves` | Base directory for repos/worktrees/issues |

## Development

```bash
pytest tests/
```
