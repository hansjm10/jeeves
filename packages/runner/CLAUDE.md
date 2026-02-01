# Runner (packages/runner)

SDK integration layer for running agent phases. Bridges workflows/prompts to agent providers.

## Responsibilities

- Execute workflow phases via agent providers
- Stream provider events to output files
- Manage run artifacts (logs, SDK output, progress)
- Support multiple agent backends (Claude SDK, Codex SDK)

## Key Files

| File | Purpose |
|------|---------|
| `src/runner.ts` | Core run logic (`runPhaseOnce`, `runWorkflowOnce`, `runSinglePhaseOnce`) |
| `src/provider.ts` | `AgentProvider` interface definition |
| `src/providers/claudeAgentSdk.ts` | Claude Agent SDK provider |
| `src/providers/codexSdk.ts` | Codex/OpenAI SDK provider |
| `src/outputWriter.ts` | SDK output JSON writer |
| `src/progress.ts` | Progress file management |
| `src/cli.ts` | CLI interface |

## Provider Interface

```typescript
interface AgentProvider {
  readonly name: string;
  run(prompt: string, options: ProviderRunOptions): AsyncIterable<ProviderEvent>;
}

type ProviderEvent =
  | { type: 'system'; subtype?: 'init' | 'error'; content: string; sessionId?: string }
  | { type: 'user' | 'assistant' | 'result'; content: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean; durationMs?: number };
```

## Run Artifacts

Each run produces these files in the state directory:

| File | Purpose |
|------|---------|
| `last-run.log` | Human-readable log of events |
| `sdk-output.json` | Structured JSON of messages, tool calls, stats |
| `progress.txt` | Handoff notes between iterations |

## Output Format (sdk-output.json)

```json
{
  "session_id": "...",
  "started_at": "ISO timestamp",
  "ended_at": "ISO timestamp",
  "messages": [...],
  "tool_calls": [...],
  "stats": { "input_tokens": N, "output_tokens": N },
  "success": true
}
```

## Iteration Pattern

The runner supports the "Ralph Wiggum" iteration pattern:
1. Each iteration is a fresh subprocess with new context
2. Handoff between iterations via `progress.txt`
3. Agents read progress at start, write updates during run
4. Completion signaled via `<promise>COMPLETE</promise>` in output

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

- Providers are async iterables yielding `ProviderEvent`
- All file writes use atomic operations
- Log format: `[TYPE] content` (e.g., `[TOOL] Read {...}`)
- Progress markers: `[started]`, `[phase:name]`, `[ended:success|failure]`
