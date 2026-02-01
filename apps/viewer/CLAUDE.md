# Viewer (apps/viewer)

React-based web UI for Jeeves. Built with Vite and TypeScript.

## Responsibilities

- Real-time run control and status display
- Live log streaming (agent logs, viewer logs)
- SDK event visualization (tool calls, messages, timelines)
- Prompt template editing
- Issue selection and initialization
- Workflow graph visualization

## Key Files

| File | Purpose |
|------|---------|
| `src/main.tsx` | Entry point |
| `src/App.tsx` | Root component, routing setup |
| `src/styles.css` | Global styles using shared tokens |
| `src/styles/tokens.css` | Design tokens (single source of truth) |
| `src/pages/SdkPage.tsx` | SDK event timeline UI |
| `src/pages/WorkflowsPage.tsx` | Workflow editor/viewer |
| `src/layout/AppShell.tsx` | Main layout wrapper |

## Styling Conventions

### Design Tokens

All styles must use tokens from `src/styles/tokens.css`:

```css
/* Colors */
--color-bg, --color-surface-1, --color-surface-2, --color-surface-inset
--color-border, --color-border-subtle
--color-text, --color-text-muted, --color-text-dim
--color-accent-blue, --color-accent-green, --color-accent-amber
--color-accent-red, --color-accent-purple, --color-accent-cyan

/* Typography */
--font-sans, --font-mono
--font-size-body, --font-size-ui-sm, --font-size-ui-xs

/* Shape */
--radius-sm, --radius-md, --radius-lg, --radius-xl, --radius-pill

/* Spacing */
--space-1 through --space-8
```

### Rules

1. **Use tokens, not raw values**: Always reference `--color-*`, `--font-*`, etc.
2. **No `color-mix()`**: Use explicit RGBA values for transparency (e.g., `rgba(88, 166, 255, 0.12)`)
3. **Legacy aliases are deprecated**: `--bg`, `--panel`, `--text`, etc. exist for backward compatibility only
4. **Semantic naming**: Use accent colors for semantic purposes (success, error, warning)

### Adding New Styles

1. Check if a shared class exists in `src/styles.css`
2. Prefer extending shared classes over creating new ones
3. Page-specific styles go in `src/pages/<Page>.css`
4. Always use token variables, never raw hex/rgb values

## Validating UI Changes

```bash
# Type check
pnpm typecheck

# Lint
pnpm lint

# Build (catches CSS errors)
pnpm build

# Dev server (visual verification)
pnpm dev
```

Then open `http://localhost:5173` and verify:
- Pages render without console errors
- Interactive elements work (buttons, dropdowns, filters)
- Dark theme is consistent across pages
- No visual regressions in affected components

## Component Patterns

- **Cards**: Use `.card`, `.cardTitle`, `.cardBody` classes
- **Buttons**: Use `.btn`, `.btn.primary`, `.btn.danger` classes
- **Inputs**: Use `.input`, `.inputError` classes
- **Panels**: Use `.panel`, `.panelTitle`, `.panelBody` classes
- **Lists**: Use `.selectList`, `.listItem`, `.listItem.active` classes
- **Pills/Badges**: Use `.pill`, `.pill.ok`, `.pill.bad`, `.pill.idle` classes
