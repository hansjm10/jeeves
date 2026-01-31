export function LogPanel(props: { title: string; lines: string[] }) {
  return (
    <div className="panel">
      <div className="panelTitle">{props.title}</div>
      <div className="panelBody">
        <div className="muted">lines: {props.lines.length}</div>
        <pre className="log">{props.lines.join('\n')}</pre>
      </div>
    </div>
  );
}

