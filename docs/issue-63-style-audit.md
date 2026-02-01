# Issue #63 Style Audit

This document records the styling audit performed as part of the viewer CSS standardization effort.

## 1. Missing CSS Classes (Now Defined)

The following classes were referenced in TSX files but were not defined in CSS:

| Class | File(s) Using It | Resolution |
|-------|-----------------|------------|
| `inputError` | `apps/viewer/src/layout/Sidebar.tsx:192` | Added to `styles.css` (line 222-226) - applies error border and subtle red background |
| `errorText` | `apps/viewer/src/layout/Sidebar.tsx:202` | Added to `styles.css` (line 228-231) - applies red color and small font size |

## 2. Duplicate Palettes Removed

### Completed Removals

**`apps/viewer/src/pages/SdkPage.css` — `--sdk-*` palette removed (T3, T8)**:

| Old Variable | Replaced With |
|--------------|---------------|
| `--sdk-bg` | `var(--color-bg)` |
| `--sdk-surface` | `var(--color-surface-1)` |
| `--sdk-surface-2` | `var(--color-surface-2)` |
| `--sdk-border` | `var(--color-border)` |
| `--sdk-text` | `var(--color-text)` |
| `--sdk-text-muted` | `var(--color-text-muted)` |
| `--sdk-cyan` | `var(--color-accent-cyan)` |
| `--sdk-red` | `var(--color-accent-red)` |
| `--sdk-amber` | `var(--color-accent-amber)` |
| `--sdk-green` | `var(--color-accent-green)` |
| `--sdk-purple` | `var(--color-accent-purple)` |
| `--sdk-blue` | `var(--color-accent-blue)` |

**`apps/viewer/src/pages/WorkflowsPage.css` — `--wf-*` palette removed (T4, T7)**:

| Old Variable | Replaced With |
|--------------|---------------|
| `--wf-bg` | `var(--color-bg)` |
| `--wf-surface` | `var(--color-surface-1)` |
| `--wf-surface-2` | `var(--color-surface-2)` |
| `--wf-border` | `var(--color-border)` |
| `--wf-border-subtle` | `var(--color-border-subtle)` |
| `--wf-text` | `var(--color-text)` |
| `--wf-text-muted` | `var(--color-text-muted)` |
| `--wf-text-dim` | `var(--color-text-dim)` |
| `--wf-cyan` | `var(--color-accent-cyan)` |
| `--wf-red` | `var(--color-accent-red)` |
| `--wf-amber` | `var(--color-accent-amber)` |
| `--wf-green` | `var(--color-accent-green)` |
| `--wf-purple` | `var(--color-accent-purple)` |
| `--wf-blue` | `var(--color-accent-blue)` |

**`apps/viewer/src/styles.css` — Legacy aliases converted to token references**:

| Old Variable | Now Points To |
|--------------|---------------|
| `--bg` | `var(--color-bg)` |
| `--panel` | `var(--color-surface-1)` |
| `--panel2` | `var(--color-surface-2)` |
| `--border` | `var(--color-border)` |
| `--text` | `var(--color-text)` |
| `--muted` | `var(--color-text-muted)` |
| `--green` | `var(--color-accent-green)` |
| `--blue` | `var(--color-accent-blue)` |
| `--red` | `var(--color-accent-red)` |
| `--mono` | `var(--font-mono)` |
| `--sans` | `var(--font-sans)` |

**Note:** These legacy aliases remain for backward compatibility but should not be used in new code.

## 3. Remaining Hard-Coded Colors

Per the design doc policy: **hex colors are allowed only in `apps/viewer/src/styles/tokens.css`**; all other color literals must be explicit **RGBA overlays** (no `color-mix()`).

### Tokens File (Authoritative Hex Definitions)

All hex colors in `apps/viewer/src/styles/tokens.css` are intentional and define the single source of truth:

| Token | Hex Value | Purpose |
|-------|-----------|---------|
| `--color-bg` | `#0d1117` | Page background |
| `--color-surface-1` | `#161b22` | Primary surface |
| `--color-surface-2` | `#21262d` | Secondary surface |
| `--color-surface-inset` | `#0b1118` | Inset surfaces (inputs, logs) |
| `--color-border` | `#30363d` | Default borders |
| `--color-text` | `#e6edf3` | Primary text |
| `--color-text-muted` | `#8b949e` | Muted text |
| `--color-accent-blue` | `#58a6ff` | Blue accent |
| `--color-accent-green` | `#3fb950` | Green accent |
| `--color-accent-amber` | `#ecc94b` | Amber accent |
| `--color-accent-red` | `#f85149` | Red accent |
| `--color-accent-purple` | `#a371f7` | Purple accent |
| `--color-accent-cyan` | `#4fd1c5` | Cyan accent |

### RGBA Overlays (Intentionally Retained)

The following RGBA values appear throughout `apps/viewer/src/**/*.css` and are intentional per the design doc:

| Color Pattern | Base Token | Usage | Rationale |
|---------------|------------|-------|-----------|
| `rgba(88, 166, 255, 0.xx)` | `--color-accent-blue` | Focus rings, active states, button hovers, scroll highlights | Blue accent at various opacities for interactive states |
| `rgba(248, 81, 73, 0.xx)` | `--color-accent-red` | Error states, danger buttons, diff deletions | Red accent at various opacities for error/danger states |
| `rgba(63, 185, 80, 0.xx)` | `--color-accent-green` | Success states, diff additions, active badges | Green accent at various opacities for success states |
| `rgba(236, 201, 75, 0.xx)` | `--color-accent-amber` | Warning states, warning indicators | Amber accent at various opacities for warning states |
| `rgba(163, 113, 247, 0.xx)` | `--color-accent-purple` | Gradient endpoints, accent surfaces | Purple accent for gradients and special surfaces |
| `rgba(139, 148, 158, 0.xx)` | `--color-text-muted` | Idle states, muted backgrounds, chip hovers | Muted gray tints for de-emphasized states |
| `rgba(48, 54, 61, 0.xx)` | `--color-border` | Subtle borders | Border color at reduced opacity |
| `rgba(13, 17, 23, 0.xx)` | `--color-bg` | Header overlays, frosted glass effects | Background color at high opacity for overlays |
| `rgba(22, 27, 34, 0.xx)` | (surface variant) | Toast backgrounds | Semi-transparent dark surface |
| `rgba(0, 0, 0, 0.xx)` | (black) | Drop shadows, box-shadow overlays | Standard shadow color |

These RGBA values follow the design decision to avoid `color-mix()` and instead use explicit opacity-based overlays derived from the accent token colors.

### Graph Colors (WorkflowGraph.tsx — T9)

The `WorkflowGraph.tsx` component previously contained 18 hard-coded hex colors. These were removed in T9 and replaced with a runtime token resolution system:

- `getCssVar()` helper reads CSS custom properties at runtime
- `getGraphColors()` maps token names to resolved values
- Graph elements now use tokens: `--color-accent-blue` (selected), `--color-accent-amber` (current phase), `--color-border`, `--color-text-muted`, etc.

## 4. Typography Policy Compliance

Per the design doc:
- **Sans-serif (`--font-sans`)**: Default for all UI controls, navigation, headers, forms, labels, buttons
- **Monospace (`--font-mono`)**: Only for log/code/JSON surfaces, technical data displays

### SDK Page (T8)
- `.sdk-container` uses `var(--font-sans)` for UI elements
- Data surfaces use `var(--font-mono)`: `.sdk-json`, `.sdk-tool-json`, `.sdk-bash-command`, `.sdk-file-path code`, `.sdk-content-preview pre`, `.sdk-glob-pattern`, `.sdk-grep-pattern`, `.sdk-diff-old/new pre`, `.sdk-task-prompt pre`, `.sdk-tool-generic-json`, `.sdk-timeline-session-id`

### Workflows Page (T7)
- Container uses `var(--font-sans)` for general UI
- Only `.wf-json-pre` (JSON preview) uses `var(--font-mono)`

## 5. Inline Styles

### Intentionally Kept

The following inline style patterns appear in TSX and are kept as-is:

| Pattern | Example Location | Rationale |
|---------|------------------|-----------|
| `style={{ marginTop: 10 }}` | Multiple Sidebar.tsx, WorkflowsPage.tsx | One-off layout spacing; not a reusable pattern |
| `style={{ marginBottom: 10 }}` | Sidebar.tsx, WorkflowsPage.tsx | One-off layout spacing |
| `style={{ '--event-color': color }}` | SdkPage.tsx | Dynamic CSS variable for per-event theming |
| `style={{ display: 'flex', alignItems: 'center', gap: 8 }}` | CreateIssuePage.tsx | Checkbox label layout; contextual to form structure |

Per design guidelines: inline styles are acceptable when truly one-off and not encoding a reusable convention.

### Inline RGBA Color Literals (TSX)

The following RGBA color literals appear in TSX inline styles and are intentionally kept:

| Literal | Location | Rationale |
|---------|----------|-----------|
| `'1px solid rgba(255,255,255,0.1)'` | `CreateIssuePage.tsx:138` | Markdown preview panel border; uses white semi-transparent overlay for subtle delineation. One-off preview container styling, not a reusable pattern. |
| `'rgba(0,0,0,0.15)'` | `CreateIssuePage.tsx:141` | Markdown preview panel background; provides subtle darkening for visual distinction from the main form area. One-off preview container styling. |

**Policy note:** These inline RGBA overlays conform to the design doc color-literal policy (explicit RGBA allowed; no hex outside tokens; no `color-mix()`). They are kept inline rather than extracted to CSS because:
1. The preview panel is a single-use component not replicated elsewhere in the viewer
2. The styling is tied to the component's specific layout structure (inline `style` prop on a `div`)
3. Extracting would add a CSS class used only once with no reuse benefit

## 6. Token Migration Summary

All viewer CSS now consistently references the shared token system:

- **Colors:** `--color-*` tokens from `tokens.css`
- **Typography:** `--font-sans`, `--font-mono`, `--font-size-*` tokens
- **Spacing:** `--space-1` through `--space-8`
- **Radii:** `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-pill`

### Verification Commands

```bash
# Verify no --sdk-* palette variables remain
rg -- '--sdk-' apps/viewer/src
# Expected: 0 matches

# Verify no --wf-* palette variables remain
rg -- '--wf-' apps/viewer/src
# Expected: 0 matches

# Verify no color-mix() usage
rg -- 'color-mix\(' apps/viewer/src
# Expected: 0 matches

# Verify no hex colors outside tokens.css
rg '#[0-9a-fA-F]{3,8}\b' apps/viewer/src --glob '!**/tokens.css'
# Expected: 0 matches
```

## 7. Task Completion Summary

| Task | Status | Key Changes |
|------|--------|-------------|
| T1 | Passed | Created `tokens.css`, added legacy aliases |
| T2 | Passed | Standardized shared component styles, added missing classes |
| T3 | Passed | Removed `--sdk-*` palette, replaced `color-mix()` |
| T4 | Passed | Removed `--wf-*` palette, replaced `color-mix()` |
| T7 | Passed | Finished Workflows tokenization + typography |
| T8 | Passed | Finished SDK tokenization + typography |
| T9 | Passed | Tokenized WorkflowGraph colors |
| T10 | In Progress | Updated this audit doc + styling docs |
