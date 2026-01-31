export function Header(props: { baseUrl: string; connected: boolean; runRunning: boolean }) {
  return (
    <header className="header">
      <div className="brand">
        <div className="logo">J</div>
        <div>
          <div className="title">Jeeves Viewer</div>
          <div className="subtitle">{props.baseUrl}</div>
        </div>
      </div>
      <div className="status">
        <div className={`pill ${props.connected ? 'ok' : 'bad'}`}>{props.connected ? 'connected' : 'disconnected'}</div>
        <div className={`pill ${props.runRunning ? 'ok' : 'idle'}`}>{props.runRunning ? 'running' : 'idle'}</div>
      </div>
    </header>
  );
}

