/**
 * Run-focus sidebar override storage primitives.
 *
 * Provides safe read/write helpers for the `jeeves.watch.sidebar.runOverride`
 * localStorage key, which controls whether the sidebar is automatically hidden
 * during active runs ("auto") or explicitly kept open by the user ("open").
 *
 * Design contract (Section 4 of issue-71-design.md):
 * - Allowed values: exact `"auto"` or `"open"` (case-sensitive).
 * - Absent, invalid, or unreadable values resolve to `"auto"`.
 * - Read/write helpers never throw, even when localStorage is unavailable.
 */

/** localStorage key for run-time sidebar override. */
export const RUN_OVERRIDE_STORAGE_KEY = 'jeeves.watch.sidebar.runOverride';

/** Normalized run override values consumed by focus-state derivation. */
export type RunOverride = 'auto' | 'open';

/**
 * Parse a raw value into a normalized {@link RunOverride}.
 *
 * Only exact `"auto"` and `"open"` strings are accepted; everything else
 * (including `null`, `undefined`, empty string, casing variants, and
 * unexpected values) resolves to `"auto"`.
 *
 * @param raw - The raw value read from storage (or any unknown source).
 * @returns A normalized `RunOverride`.
 */
export function parseRunOverride(raw: unknown): RunOverride {
  if (raw === 'auto' || raw === 'open') return raw;
  return 'auto';
}

/**
 * Read the persisted run override from localStorage.
 *
 * Never throws. Returns `"auto"` when:
 * - The key is absent.
 * - The stored value is not a recognized override.
 * - localStorage is unavailable or blocked (e.g. private browsing, quota).
 *
 * @returns A normalized `RunOverride`.
 */
export function readRunOverride(): RunOverride {
  try {
    return parseRunOverride(localStorage.getItem(RUN_OVERRIDE_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

/**
 * Write a run override value to localStorage.
 *
 * Never throws. If localStorage is unavailable or the write fails for any
 * reason, the error is silently swallowed and the caller can continue with
 * in-memory state.
 *
 * @param value - The override value to persist.
 */
export function writeRunOverride(value: RunOverride): void {
  try {
    localStorage.setItem(RUN_OVERRIDE_STORAGE_KEY, value);
  } catch {
    // Ignore — fall back to in-memory behavior for this session.
  }
}

/**
 * Clear the persisted run override from localStorage.
 *
 * Never throws. Subsequent reads will resolve to the default `"auto"`.
 */
export function clearRunOverride(): void {
  try {
    localStorage.removeItem(RUN_OVERRIDE_STORAGE_KEY);
  } catch {
    // Ignore — fall back to in-memory behavior for this session.
  }
}
