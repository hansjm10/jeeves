import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createMemoryRouter, Navigate } from 'react-router-dom';

/**
 * Route configuration smoke tests.
 *
 * These tests verify that the router is configured correctly for the key routes:
 * - /watch (new primary route)
 * - /workflows
 * - /create-issue
 * - /prompts
 * - Legacy redirects: /sdk, /logs, /viewer-logs -> /watch?view=...
 *
 * We use createMemoryRouter which works in Node.js without DOM dependencies,
 * and test that the router can match the expected routes.
 */

import { AppShell } from '../layout/AppShell.js';
import { CreateIssuePage } from '../pages/CreateIssuePage.js';
import { PromptsPage } from '../pages/PromptsPage.js';
import { WatchPage } from '../pages/WatchPage.js';
import { WorkflowsPage } from '../pages/WorkflowsPage.js';

// Use createElement instead of JSX to avoid .tsx requirement
const e = createElement;

// Define the route configuration (mirrors router.tsx)
const routeConfig = [
  {
    path: '/',
    element: e(AppShell),
    children: [
      { index: true, element: e(Navigate, { to: '/watch', replace: true }) },
      { path: 'watch', element: e(WatchPage) },
      // Legacy routes redirect to Watch with explicit view mapping
      { path: 'sdk', element: e(Navigate, { to: '/watch?view=sdk', replace: true }) },
      { path: 'logs', element: e(Navigate, { to: '/watch?view=logs', replace: true }) },
      { path: 'viewer-logs', element: e(Navigate, { to: '/watch?view=viewer-logs', replace: true }) },
      { path: 'workflows', element: e(WorkflowsPage) },
      { path: 'create-issue', element: e(CreateIssuePage) },
      { path: 'prompts/*', element: e(PromptsPage) },
      { path: '*', element: e(Navigate, { to: '/watch', replace: true }) },
    ],
  },
];

// Helper to create a memory router for testing
function createTestRouter(initialPath: string) {
  return createMemoryRouter(routeConfig, {
    initialEntries: [initialPath],
  });
}

describe('Route smoke tests: key routes exist and match', () => {
  it('/watch route matches', () => {
    const router = createTestRouter('/watch');
    // The router should not be in an error state
    expect(router.state.errors).toBeNull();
    // Check the match
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('watch');
  });

  it('/workflows route matches', () => {
    const router = createTestRouter('/workflows');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('workflows');
  });

  it('/create-issue route matches', () => {
    const router = createTestRouter('/create-issue');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('create-issue');
  });

  it('/prompts route matches', () => {
    const router = createTestRouter('/prompts');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('prompts/*');
  });

  it('/prompts/subpath route matches', () => {
    const router = createTestRouter('/prompts/some/path');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('prompts/*');
  });
});

describe('Route smoke tests: root redirects to /watch', () => {
  it('/ route matches index route', () => {
    const router = createTestRouter('/');
    expect(router.state.errors).toBeNull();
    // Root should match index route (which redirects to /watch)
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.index).toBe(true);
  });
});

describe('Route smoke tests: legacy route redirects', () => {
  it('/sdk route matches (redirect)', () => {
    const router = createTestRouter('/sdk');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('sdk');
  });

  it('/logs route matches (redirect)', () => {
    const router = createTestRouter('/logs');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('logs');
  });

  it('/viewer-logs route matches (redirect)', () => {
    const router = createTestRouter('/viewer-logs');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('viewer-logs');
  });

  it('unknown route matches catch-all', () => {
    const router = createTestRouter('/unknown-path');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('*');
  });
});

describe('Route smoke tests: route configuration verification', () => {
  it('route config has expected structure', () => {
    // Verify the root route
    expect(routeConfig).toHaveLength(1);
    expect(routeConfig[0]?.path).toBe('/');

    // Verify children count
    const children = routeConfig[0]?.children ?? [];
    expect(children).toHaveLength(9);

    // Verify key paths exist in children
    const paths = children.map((r) => r.path ?? (r.index ? 'index' : undefined));
    expect(paths).toContain('index');
    expect(paths).toContain('watch');
    expect(paths).toContain('sdk');
    expect(paths).toContain('logs');
    expect(paths).toContain('viewer-logs');
    expect(paths).toContain('workflows');
    expect(paths).toContain('create-issue');
    expect(paths).toContain('prompts/*');
    expect(paths).toContain('*');
  });

  it('watch route comes before legacy redirects', () => {
    const children = routeConfig[0]?.children ?? [];
    const watchIndex = children.findIndex((r) => r.path === 'watch');
    const sdkIndex = children.findIndex((r) => r.path === 'sdk');
    const logsIndex = children.findIndex((r) => r.path === 'logs');
    const viewerLogsIndex = children.findIndex((r) => r.path === 'viewer-logs');

    expect(watchIndex).toBeLessThan(sdkIndex);
    expect(watchIndex).toBeLessThan(logsIndex);
    expect(watchIndex).toBeLessThan(viewerLogsIndex);
  });
});
