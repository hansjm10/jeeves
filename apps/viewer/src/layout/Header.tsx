import { useFocusMode } from './AppShell.js';
import { isSidebarVisible } from './runFocusState.js';

export function Header(props: { baseUrl: string; connected: boolean; runRunning: boolean }) {
  const focusMode = useFocusMode();

  // Determine whether to show the focused-mode sidebar control.
  // Show the control when the sidebar is not in default visible-idle state (W0).
  const showFocusControl = focusMode !== null && focusMode.focusState !== 'W0';
  const sidebarVisible = focusMode !== null && isSidebarVisible(focusMode.focusState);

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
        {showFocusControl && (
          <button
            className="pill focus-toggle"
            onClick={sidebarVisible ? focusMode.onUserHide : focusMode.onUserReopen}
          >
            {sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar'}
          </button>
        )}
        <div className={`pill ${props.connected ? 'ok' : 'bad'}`}>{props.connected ? 'connected' : 'disconnected'}</div>
        <div className={`pill ${props.runRunning ? 'ok' : 'idle'}`}>{props.runRunning ? 'running' : 'idle'}</div>
      </div>
    </header>
  );
}

