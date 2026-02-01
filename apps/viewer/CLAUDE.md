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

1. **Use tokens, not raw values**: Always reference `--color-*`, `--font-*`, etc. from `src/styles/tokens.css`
2. **No hex colors outside tokens.css**: All hex color definitions (`#rrggbb`) must be in `src/styles/tokens.css`
3. **RGBA overlays are allowed**: For transparency effects (hover states, focus rings, shadows), use explicit RGBA values derived from token colors (e.g., `rgba(88, 166, 255, 0.12)` for blue accent at 12% opacity)
4. **No `color-mix()`**: Avoid `color-mix()` entirely; use explicit RGBA overlays instead
5. **Legacy aliases are deprecated**: `--bg`, `--panel`, `--text`, etc. exist for backward compatibility only
6. **Semantic naming**: Use accent colors for semantic purposes (success, error, warning)

### Color Policy Summary

| Allowed | Not Allowed |
|---------|-------------|
| `var(--color-accent-blue)` | `#58a6ff` (outside tokens.css) |
| `rgba(88, 166, 255, 0.15)` | `color-mix(in srgb, var(--color-accent-blue) 15%, transparent)` |
| Token references anywhere | Hex literals outside tokens.css |

### Adding New Styles

1. Check if a shared class exists in `src/styles.css`
2. Prefer extending shared classes over creating new ones
3. Page-specific styles go in `src/pages/<Page>.css`
4. For solid colors, use token variables (e.g., `var(--color-accent-blue)`)
5. For transparent colors, use RGBA overlays based on token values

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
