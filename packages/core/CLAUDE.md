# Core (packages/core)

Shared domain logic for Jeeves. Defines workflows, state management, and path conventions.

## Responsibilities

- Workflow definition and validation
- Workflow loading (YAML/JSON parsing)
- Workflow engine (phase transitions, guards)
- Issue state management
- Path resolution (data dirs, worktrees, prompts)
- Prompt resolution

## Key Files

| File | Purpose |
|------|---------|
| `src/workflow.ts` | Workflow/Phase/Transition types, model constants |
| `src/workflowLoader.ts` | Parse YAML/JSON workflows, serialize to YAML |
| `src/workflowEngine.ts` | Evaluate transitions, check guards |
| `src/guards.ts` | Guard expression evaluation |
| `src/issueState.ts` | Issue state CRUD operations |
| `src/paths.ts` | Path resolution utilities |
| `src/promptResolution.ts` | Resolve phase to prompt file |

## Workflow Types

```typescript
type PhaseType = 'execute' | 'evaluate' | 'script' | 'terminal';

type Phase = {
  name: string;
  type: PhaseType;
  provider?: string;
  prompt?: string;
  command?: string;
  transitions: Transition[];
  model?: string;
  reasoningEffort?: CodexReasoningEffortId;
  thinkingBudget?: ClaudeThinkingBudgetId;
};

type Workflow = {
  name: string;
  version: number;
  start: string;
  phases: Record<string, Phase>;
  defaultProvider?: string;
  defaultModel?: string;
};
```

## Model Support

### Claude Models
- `sonnet`, `opus`, `haiku`
- Thinking budget: `none`, `low`, `medium`, `high`, `max`

### Codex Models
- `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5-codex`
- Reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh`

## Path Conventions

```
$JEEVES_DATA_DIR/
├── issues/<owner>/<repo>/<issue>/
│   └── issue.json
└── worktrees/<owner>/<repo>/issue-<N>/
    └── (git worktree)
```

## Exports

```typescript
// Paths
export { parseIssueRef, parseRepoSpec, resolveDataDir, getIssueStateDir, ... };

// Issue State
export { createIssueState, loadIssueState, listIssueStates, ... };

// Workflows
export { loadWorkflowByName, parseWorkflowYaml, parseWorkflowObject, toWorkflowYaml, ... };

// Engine
export { WorkflowEngine, evaluateGuard, resolvePromptPath };
```

## Development

```bash
# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## Conventions

- All types are `Readonly<>` for immutability
- Workflow validation throws `WorkflowValidationError`
- Path functions never create directories (caller responsibility)
- Guard expressions use simple `status.field` or `status.field == value` syntax
