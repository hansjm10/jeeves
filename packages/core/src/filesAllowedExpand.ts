function hasExplicitTestMarker(pattern: string): boolean {
  const base = pattern.split('/').pop() ?? pattern;
  return base.includes('.test.') || base.endsWith('.test');
}

function splitTsExtension(pattern: string): { stem: string; ext: '.ts' | '.tsx' } | null {
  if (pattern.endsWith('.tsx')) return { stem: pattern.slice(0, -'.tsx'.length), ext: '.tsx' };
  if (pattern.endsWith('.ts')) return { stem: pattern.slice(0, -'.ts'.length), ext: '.ts' };
  return null;
}

function insertTestsDir(pattern: string): string | null {
  if (pattern.includes('/__tests__/') || pattern.startsWith('__tests__/')) return null;
  const idx = pattern.lastIndexOf('/');
  if (idx === -1) return `__tests__/${pattern}`;
  const dir = pattern.slice(0, idx);
  const file = pattern.slice(idx + 1);
  return `${dir}/__tests__/${file}`;
}

function addTestSuffix(stem: string, ext: '.ts' | '.tsx'): string {
  const needsDot = !stem.endsWith('.') && !stem.endsWith('/');
  return `${stem}${needsDot ? '.' : ''}test${ext}`;
}

/**
 * Expands task `filesAllowed` patterns to include common colocated test-file variants.
 *
 * Goal (issue #72): if a source file is allowed, its corresponding tests should be allowed too, to avoid
 * spec_check failures from accidental test edits.
 *
 * Expansion rules (best-effort, pattern-based):
 * - For `*.ts` / `*.tsx` patterns that do NOT already look like test files:
 *   - allow same-dir `*.test.ts` and `*.test.tsx` (cross-extension allowed)
 *   - allow `__tests__/` variants:
 *     - `.../__tests__/...<originalExt>` (plain)
 *     - `.../__tests__/...test.ts` and `.../__tests__/...test.tsx` (cross-extension allowed)
 *
 * The function is idempotent and preserves input ordering as much as possible.
 */
export function expandFilesAllowedForTests(filesAllowed: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | null | undefined) => {
    if (!value) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  for (const pattern of filesAllowed) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    push(pattern);

    if (hasExplicitTestMarker(pattern)) continue;
    const split = splitTsExtension(pattern);
    if (!split) continue;

    const { stem } = split;
    const testExts: ('.ts' | '.tsx')[] = ['.ts', '.tsx'];

    for (const e of testExts) {
      push(addTestSuffix(stem, e));
    }

    const inTests = insertTestsDir(pattern);
    const inTestsStem = insertTestsDir(stem);
    if (inTests) {
      push(inTests);
      for (const e of testExts) {
        if (inTestsStem) push(addTestSuffix(inTestsStem, e));
      }
    }
  }

  return out;
}
