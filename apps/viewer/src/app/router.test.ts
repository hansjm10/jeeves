/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createMemoryRouter, Navigate } from 'react-router-dom';

/**
 * Route configuration smoke tests.
 *
 * These tests verify that the router is configured correctly for the key routes:
 * - /watch (new primary route)
 * - /workflows
 * - /create-issue
 * - /sonar-token
 * - /azure-devops
 * - /prompts
 * - Legacy redirects: /sdk, /logs, /viewer-logs -> /watch?view=...
 *
 * We use createMemoryRouter which works in Node.js without DOM dependencies,
 * and test that the router can match the expected routes.
 *
 * Source-file assertions verify the actual router.tsx to prevent config drift.
 */

import { AppShell } from '../layout/AppShell.js';
import { AzureDevopsPage } from '../pages/AzureDevopsPage.js';
import { CreateIssuePage } from '../pages/CreateIssuePage.js';
import { PromptsPage } from '../pages/PromptsPage.js';
import { ProjectFilesPage } from '../pages/ProjectFilesPage.js';
import { SonarTokenPage } from '../pages/SonarTokenPage.js';
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
      { path: 'sonar-token', element: e(SonarTokenPage) },
      { path: 'azure-devops', element: e(AzureDevopsPage) },
      { path: 'project-files', element: e(ProjectFilesPage) },
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

  it('/sonar-token route matches', () => {
    const router = createTestRouter('/sonar-token');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('sonar-token');
  });

  it('/azure-devops route matches', () => {
    const router = createTestRouter('/azure-devops');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('azure-devops');
  });

  it('/prompts route matches', () => {
    const router = createTestRouter('/prompts');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('prompts/*');
  });

  it('/project-files route matches', () => {
    const router = createTestRouter('/project-files');
    expect(router.state.errors).toBeNull();
    const match = router.state.matches[router.state.matches.length - 1];
    expect(match?.route.path).toBe('project-files');
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

    // Verify children count (index + watch + sdk + logs + viewer-logs + workflows + create-issue + sonar-token + azure-devops + project-files + prompts/* + *)
    const children = routeConfig[0]?.children ?? [];
    expect(children).toHaveLength(12);

    // Verify key paths exist in children
    const paths = children.map((r) => r.path ?? (r.index ? 'index' : undefined));
    expect(paths).toContain('index');
    expect(paths).toContain('watch');
    expect(paths).toContain('sdk');
    expect(paths).toContain('logs');
    expect(paths).toContain('viewer-logs');
    expect(paths).toContain('workflows');
    expect(paths).toContain('create-issue');
    expect(paths).toContain('sonar-token');
    expect(paths).toContain('azure-devops');
    expect(paths).toContain('project-files');
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

// ============================================================================
// T13: Source-file assertions against actual router.tsx
// ============================================================================

const __test_dirname = dirname(fileURLToPath(import.meta.url));
const ROUTER_SOURCE_PATH = resolve(__test_dirname, './router.tsx');

function readRouterSource(): string {
  return readFileSync(ROUTER_SOURCE_PATH, 'utf-8');
}

describe('T13: router.tsx source-file route verification', () => {
  let routerSource: string;

  beforeAll(() => {
    routerSource = readRouterSource();
  });

  it('contains all expected route paths in children array', () => {
    const expectedPaths = [
      'watch',
      'sdk',
      'logs',
      'viewer-logs',
      'workflows',
      'create-issue',
      'sonar-token',
      'azure-devops',
      'project-files',
      'prompts/*',
    ];

    for (const path of expectedPaths) {
      expect(routerSource).toContain(`path: '${path}'`);
    }
  });

  it('has index route redirecting to /watch', () => {
    expect(routerSource).toContain('index: true');
    expect(routerSource).toMatch(/index:\s*true.*Navigate.*\/watch/s);
  });

  it('has catch-all route redirecting to /watch', () => {
    expect(routerSource).toContain("path: '*'");
  });

  it('azure-devops route renders AzureDevopsPage', () => {
    expect(routerSource).toContain("import { AzureDevopsPage }");
    // Verify the route entry references AzureDevopsPage
    expect(routerSource).toMatch(/path:\s*'azure-devops'.*AzureDevopsPage/s);
  });

  it('sonar-token route renders SonarTokenPage', () => {
    expect(routerSource).toContain("import { SonarTokenPage }");
    expect(routerSource).toMatch(/path:\s*'sonar-token'.*SonarTokenPage/s);
  });

  it('root route wraps children in AppShell', () => {
    expect(routerSource).toContain("import { AppShell }");
    expect(routerSource).toMatch(/path:\s*'\/'[\s\S]*element:.*AppShell/);
  });
});
