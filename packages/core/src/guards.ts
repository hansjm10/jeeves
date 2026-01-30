type Context = Record<string, unknown>;

function isPlainRecord(value: unknown): value is Context {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getNestedValue(context: Context, dottedPath: string): unknown {
  const parts = dottedPath.split('.');
  let current: unknown = context;

  for (const part of parts) {
    if (!isPlainRecord(current)) return undefined;
    current = current[part];
  }

  return current;
}

function parseValue(valueText: string): unknown {
  const trimmed = valueText.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  if (lowered === 'null' || lowered === 'none') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function evaluateComparison(expression: string, context: Context): boolean {
  const expr = expression.trim();

  if (expr.includes('!=')) {
    const [left, right] = expr.split('!=', 2);
    if (right === undefined) return false;
    const actual = getNestedValue(context, left.trim());
    const expected = parseValue(right);
    return actual !== expected;
  }

  if (expr.includes('==')) {
    const [left, right] = expr.split('==', 2);
    if (right === undefined) return false;
    const actual = getNestedValue(context, left.trim());
    const expected = parseValue(right);
    return actual === expected;
  }

  const value = getNestedValue(context, expr);
  return Boolean(value);
}

export function evaluateGuard(expression: string, context: Context): boolean {
  if (!expression || !expression.trim()) return true;

  const expr = expression.trim();

  if (expr.includes(' or ')) {
    const parts = expr.split(' or ');
    return parts.some((p) => (p.includes(' and ') ? evaluateGuard(p, context) : evaluateComparison(p, context)));
  }

  if (expr.includes(' and ')) {
    const parts = expr.split(' and ');
    return parts.every((p) => evaluateComparison(p, context));
  }

  return evaluateComparison(expr, context);
}

