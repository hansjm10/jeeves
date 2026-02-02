import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useBlocker } from 'react-router-dom';

import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useUnsavedChanges } from '../ui/unsaved/UnsavedChangesProvider.js';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';

function TabLink(props: { to: string; label: string }) {
  return (
    <NavLink to={props.to} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
      {props.label}
    </NavLink>
  );
}

export function AppShell() {
  const baseUrl = useViewerServerBaseUrl();
  const stream = useViewerStream();
  const runRunning = stream.state?.run.running ?? false;
  const { isDirty, confirmDiscard } = useUnsavedChanges();
  const blocker = useBlocker(isDirty);
  const hasPromptedRef = useRef(false);

  useEffect(() => {
    if (blocker.state !== 'blocked') {
      hasPromptedRef.current = false;
      return;
    }
    if (hasPromptedRef.current) return;
    hasPromptedRef.current = true;
    if (confirmDiscard()) blocker.proceed();
    else blocker.reset();
  }, [blocker, blocker.state, confirmDiscard]);

  return (
    <div className="app">
      <Header baseUrl={baseUrl} connected={stream.connected} runRunning={runRunning} />
      <main className="layout">
        <aside className="sidebar">
          <Sidebar />
        </aside>
        <section className="main">
          <div className="tabs">
            <TabLink to="/watch" label="watch" />
            <TabLink to="/workflows" label="workflows" />
            <TabLink to="/create-issue" label="create-issue" />
            <TabLink to="/prompts" label="prompts" />
          </div>
          <Outlet />
        </section>
      </main>
    </div>
  );
}
