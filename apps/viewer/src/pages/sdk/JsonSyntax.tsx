import { Fragment, useMemo } from 'react';

type Props = {
  data: unknown;
  className?: string;
};

function renderJsonValue(token: string) {
  const trimmed = token.trimEnd();
  const comma = trimmed.endsWith(',') ? ',' : '';
  const core = comma ? trimmed.slice(0, -1) : trimmed;

  // Strings
  if (/^"((?:\\.|[^"\\])*)"$/.test(core)) {
    return (
      <>
        <span className="json-string">{core}</span>
        {comma}
      </>
    );
  }

  // Numbers (including exponent)
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(core)) {
    return (
      <>
        <span className="json-number">{core}</span>
        {comma}
      </>
    );
  }

  // Booleans / null
  if (/^(true|false)$/.test(core)) {
    return (
      <>
        <span className="json-bool">{core}</span>
        {comma}
      </>
    );
  }
  if (core === 'null') {
    return (
      <>
        <span className="json-null">{core}</span>
        {comma}
      </>
    );
  }

  return token;
}

function renderJsonLine(line: string) {
  const indentMatch = /^(\s*)(.*)$/.exec(line);
  const indent = indentMatch?.[1] ?? '';
  const content = indentMatch?.[2] ?? line;

  const keyMatch = /^"((?:\\.|[^"\\])+)":\s(.*)$/.exec(content);
  if (keyMatch) {
    const key = keyMatch[1];
    const rest = keyMatch[2];
    return (
      <>
        {indent}
        <span className="json-key">&quot;{key}&quot;</span>: {renderJsonValue(rest)}
      </>
    );
  }

  return (
    <>
      {indent}
      {renderJsonValue(content)}
    </>
  );
}

export function JsonSyntax({ data, className }: Props) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  const lines = useMemo(() => text.split('\n'), [text]);

  return (
    <pre className={className ?? 'sdk-json'}>
      {lines.map((line, idx) => (
        <Fragment key={idx}>
          {renderJsonLine(line)}
          {idx < lines.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </pre>
  );
}

