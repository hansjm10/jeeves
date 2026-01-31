import { NavLink, Outlet } from 'react-router-dom';

import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useUnsavedChanges } from '../ui/unsaved/UnsavedChangesProvider.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';

function TabLink(props: { to: string; label: string }) {
  const { confirmDiscard } = useUnsavedChanges();
  return (
    <NavLink
      to={props.to}
      className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}
      onClick={(e) => {
        if (!confirmDiscard()) e.preventDefault();
      }}
    >
      {props.label}
    </NavLink>
  );
}

export function AppShell() {
  const baseUrl = useViewerServerBaseUrl();
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;

  return (
    <div className="app">
      <Header baseUrl={baseUrl} connected={stream.connected} runRunning={runRunning} />
      <main className="layout">
        <aside className="sidebar">
          <Sidebar />
        </aside>
        <section className="main">
          <div className="tabs">
            <TabLink to="/logs" label="logs" />
            <TabLink to="/viewer-logs" label="viewer-logs" />
            <TabLink to="/prompts" label="prompts" />
            <TabLink to="/sdk" label="sdk" />
          </div>
          <Outlet />
        </section>
      </main>
    </div>
  );
}
