# Issue #63 Style Audit

This document records the styling audit performed as part of the viewer CSS standardization effort.

## 1. Missing CSS Classes (Now Defined)

The following classes were referenced in TSX files but were not defined in CSS:

| Class | File(s) Using It | Resolution |
|-------|-----------------|------------|
| `inputError` | `apps/viewer/src/layout/Sidebar.tsx:192` | Added to `styles.css` (line 222-226) - applies error border and subtle red background |
| `errorText` | `apps/viewer/src/layout/Sidebar.tsx:202` | Added to `styles.css` (line 228-231) - applies red color and small font size |

## 2. Duplicate Palettes Removed

**Removed from `apps/viewer/src/styles.css`:**

Legacy variables at `:root` were converted to aliases pointing to shared tokens:

| Old Variable | Replaced With |
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

**Note:** The legacy aliases remain temporarily for backward compatibility with page-specific CSS (SdkPage.css, WorkflowsPage.css) until those are refactored in T3/T4. No new code should use these aliases.

**Pending removal (T3, T4):**
- `apps/viewer/src/pages/SdkPage.css`: `--sdk-*` palette variables
- `apps/viewer/src/pages/WorkflowsPage.css`: `--wf-*` palette variables

## 3. Remaining Hard-Coded Colors

The following hard-coded colors remain in `apps/viewer/src/styles.css` and are intentional:

| Color | Usage | Rationale |
|-------|-------|-----------|
| `rgba(13, 17, 23, 0.9)` | `.header` background | Semi-transparent overlay for frosted-glass effect; not a semantic token |
| `rgba(88, 166, 255, *)` | Focus/active states (multiple classes) | Blue accent tints at various opacities for interactive states |
| `rgba(248, 81, 73, *)` | Error/danger states (`.pill.bad`, `.btn.danger`, `.errorBox`, `.inputError`) | Red accent tints at various opacities for error states |
| `rgba(63, 185, 80, 0.6)` | `.pill.ok` border | Green accent tint for success states |
| `rgba(139, 148, 158, 0.4)` | `.pill.idle` border | Muted text color tint for idle states |
| `rgba(22, 27, 34, 0.95)` | `.toast` background | Semi-transparent dark surface for overlay |

These RGBA values are derived from the accent token colors (`--color-accent-blue`, `--color-accent-red`, `--color-accent-green`, `--color-text-muted`) at specific opacities. They follow the design decision to avoid `color-mix()` and use explicit RGBA overlays instead.

## 4. Inline Styles

### Changed

No inline styles in shared component areas were modified in this task. Inline styles in page-specific components (e.g., `marginTop`, `marginBottom` for spacing) remain as they are layout-specific and don't warrant new utility classes for single-use cases.

### Intentionally Kept

The following inline style patterns appear in TSX and are kept as-is:

| Pattern | Example Location | Rationale |
|---------|------------------|-----------|
| `style={{ marginTop: 10 }}` | Multiple Sidebar.tsx, WorkflowsPage.tsx | One-off layout spacing; not a reusable pattern |
| `style={{ marginBottom: 10 }}` | Sidebar.tsx, WorkflowsPage.tsx | One-off layout spacing |
| `style={{ '--event-color': color }}` | SdkPage.tsx | Dynamic CSS variable for per-event theming |
| `style={{ display: 'flex', alignItems: 'center', gap: 8 }}` | CreateIssuePage.tsx | Checkbox label layout; contextual to form structure |

Per design guidelines: inline styles are acceptable when truly one-off and not encoding a reusable convention.

## 5. Token Migration Summary

All shared classes in `styles.css` now consistently reference the shared tokens:

- **Colors:** Use `--color-*` tokens (e.g., `--color-bg`, `--color-surface-1`, `--color-border`, `--color-text`, `--color-text-muted`, `--color-accent-*`)
- **Typography:** Use `--font-sans`, `--font-mono`, `--font-size-ui-sm`, `--font-size-body`
- **Spacing:** Use `--space-*` tokens (1-8 scale)
- **Radii:** Use `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`

Legacy aliases (`--bg`, `--panel`, `--text`, etc.) are defined for backward compatibility but are not used by any shared classes.
