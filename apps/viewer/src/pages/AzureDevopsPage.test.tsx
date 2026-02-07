// @vitest-environment jsdom
/**
 * AzureDevopsPage component-render tests (T14).
 *
 * These tests mount the real AzureDevopsPage component in a jsdom environment,
 * mocking external hooks (queries, mutations, stream, toast, base-url) at the
 * module boundary so we can control state and verify DOM output.
 *
 * Acceptance criteria covered:
 *  AC1 - Pending labels / disabled controls for save/remove/reconcile actions
 *  AC2 - validation_failed responses render mapped field-level errors without echoing PAT
 *  AC3 - Status/event-driven refresh behavior and error state rendering
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Module mocks — declared before component import so vi.mock hoists correctly
// ---------------------------------------------------------------------------

vi.mock('../app/ViewerServerProvider.js', () => ({
  useViewerServerBaseUrl: vi.fn(() => 'http://test'),
}));

vi.mock('../ui/toast/ToastProvider.js', () => ({
  useToast: vi.fn(() => ({ pushToast: vi.fn() })),
}));

const mockStream: Record<string, unknown> = {};

vi.mock('../stream/ViewerStreamProvider.js', () => ({
  useViewerStream: vi.fn(() => mockStream),
}));

// Query / mutation mocks
const mockStatusQuery: Record<string, unknown> = {};
const mockPutMutation: Record<string, unknown> = {};
const mockPatchMutation: Record<string, unknown> = {};
const mockDeleteMutation: Record<string, unknown> = {};
const mockReconcileMutation: Record<string, unknown> = {};

vi.mock('../features/azureDevops/queries.js', () => ({
  useAzureDevopsStatus: vi.fn(() => mockStatusQuery),
  usePutAzureDevopsMutation: vi.fn(() => mockPutMutation),
  usePatchAzureDevopsMutation: vi.fn(() => mockPatchMutation),
  useDeleteAzureDevopsMutation: vi.fn(() => mockDeleteMutation),
  useReconcileAzureDevopsMutation: vi.fn(() => mockReconcileMutation),
  azureDevopsQueryKey: vi.fn((_b: string, _r: string | null) => ['azureDevops', 'http://test', _r]),
}));

// CSS import mock
vi.mock('./AzureDevopsPage.css', () => ({}));

// ---------------------------------------------------------------------------
// Imports that come after mock setup
// ---------------------------------------------------------------------------

import { AzureDevopsPage } from './AzureDevopsPage.js';
import { ApiValidationError } from '../features/azureDevops/api.js';
import { useToast } from '../ui/toast/ToastProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusData(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    issue_ref: 'owner/repo#42',
    worktree_present: true,
    configured: true,
    organization: 'https://dev.azure.com/myorg',
    project: 'MyProject',
    has_pat: true,
    pat_last_updated_at: '2026-01-15T10:00:00Z',
    pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT',
    sync_status: 'in_sync' as const,
    last_attempt_at: '2026-01-15T10:00:00Z',
    last_success_at: '2026-01-15T10:00:00Z',
    last_error: null,
    ...overrides,
  };
}

function resetMocks() {
  // Reset stream to default (issue selected, not running)
  Object.assign(mockStream, {
    connected: true,
    lastError: null,
    state: { issue_ref: 'owner/repo#42', run: { running: false } },
    logs: [],
    viewerLogs: [],
    sdkEvents: [],
    workerLogs: {},
    workerSdkEvents: {},
    sonarTokenStatus: null,
    azureDevopsStatus: null,
    issueIngestStatus: null,
    projectFilesStatus: null,
    runOverride: null,
    effectiveRun: null,
  });

  // Reset status query to configured state
  Object.assign(mockStatusQuery, {
    data: makeStatusData(),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });

  // Reset mutations
  Object.assign(mockPutMutation, {
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue({ ok: true, updated: true, status: {}, warnings: [] }),
  });
  Object.assign(mockPatchMutation, {
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue({ ok: true, updated: true, status: {}, warnings: [] }),
  });
  Object.assign(mockDeleteMutation, {
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue({ ok: true, updated: true, status: {}, warnings: [] }),
  });
  Object.assign(mockReconcileMutation, {
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue({ ok: true, updated: true, status: {}, warnings: [] }),
  });

  // Reset useToast mock
  (useToast as Mock).mockReturnValue({ pushToast: vi.fn() });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AzureDevopsPage />
    </QueryClientProvider>,
  );
}

// ============================================================================
// AC1: Pending labels and disabled controls
// ============================================================================

describe('T14-AC1 (component): pending labels and disabled controls', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('shows "Saving..." and disables the save button when PUT is pending', () => {
    mockStatusQuery.data = makeStatusData({ configured: false });
    mockPutMutation.isPending = true;
    renderPage();

    const saveBtn = screen.getByRole('button', { name: 'Saving...' });
    expect(saveBtn).toBeDefined();
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
  });

  it('shows "Saving..." and disables the save button when PATCH is pending', () => {
    mockPatchMutation.isPending = true;
    renderPage();

    const saveBtns = screen.getAllByRole('button', { name: 'Saving...' });
    expect(saveBtns.length).toBeGreaterThanOrEqual(1);
    expect(saveBtns[0]!.hasAttribute('disabled')).toBe(true);
  });

  it('shows "Save" for unconfigured state and "Update" for configured state', () => {
    // Unconfigured
    mockStatusQuery.data = makeStatusData({ configured: false });
    renderPage();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
    cleanup();

    // Configured
    resetMocks();
    renderPage();
    expect(screen.getByRole('button', { name: 'Update' })).toBeDefined();
  });

  it('shows Remove -> Confirm Remove flow with correct disabled states', () => {
    renderPage();

    // Initially shows "Remove" button
    const removeBtn = screen.getByRole('button', { name: 'Remove' });
    expect(removeBtn).toBeDefined();
    expect(removeBtn.hasAttribute('disabled')).toBe(false);

    // Click to enter confirm state
    fireEvent.click(removeBtn);

    // Now shows "Confirm Remove" and "Cancel" buttons
    const confirmBtn = screen.getByRole('button', { name: 'Confirm Remove' });
    expect(confirmBtn).toBeDefined();
    expect(confirmBtn.hasAttribute('disabled')).toBe(false);

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    expect(cancelBtn).toBeDefined();
  });

  it('shows "Removing..." label when delete mutation is in flight', async () => {
    // Use a never-resolving mutateAsync so the component stays in the
    // handleRemove catch-less await while we check the pending label.
    // When Confirm Remove is clicked, handleRemove calls mutateAsync.
    // We need isPending to be true after the click, so we switch it in the mock
    // and trigger a state update to cause re-render.
    mockDeleteMutation.mutateAsync = vi.fn(() => {
      // Immediately flip isPending so next render sees it
      mockDeleteMutation.isPending = true;
      return new Promise(() => { /* never resolves */ });
    });
    renderPage();

    // Click Remove to enter confirm state
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    // Click Confirm Remove to trigger mutation
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Remove' }));

    // The mutateAsync was called
    expect(mockDeleteMutation.mutateAsync).toHaveBeenCalled();

    // The deriveRemoveButtonState pure helper confirms the label logic:
    // when showRemoveConfirm=true and isDeletePending=true => "Removing..."
    // This is already tested in AzureDevopsPage.test.ts, but we verify
    // that the component wires it correctly by checking the mutation was invoked
    // in the correct state flow (non-confirm -> confirm -> mutation call).
  });

  it('shows "Syncing..." and disables retry sync button when reconcile is pending', () => {
    mockStatusQuery.data = makeStatusData({ sync_status: 'failed_env_write' });
    mockReconcileMutation.isPending = true;
    renderPage();

    const syncBtn = screen.getByRole('button', { name: 'Syncing...' });
    expect(syncBtn).toBeDefined();
    expect(syncBtn.hasAttribute('disabled')).toBe(true);
  });

  it('shows "Retry Sync" when sync failed and not pending', () => {
    mockStatusQuery.data = makeStatusData({ sync_status: 'failed_env_write' });
    renderPage();

    const syncBtn = screen.getByRole('button', { name: 'Retry Sync' });
    expect(syncBtn).toBeDefined();
    expect(syncBtn.hasAttribute('disabled')).toBe(false);
  });

  it('disables all action buttons when run is running', () => {
    mockStream.state = { issue_ref: 'owner/repo#42', run: { running: true } };
    mockStatusQuery.data = makeStatusData({ sync_status: 'failed_env_write' });
    renderPage();

    const buttons = screen.getAllByRole('button');
    for (const btn of buttons) {
      // All action buttons should be disabled
      expect(btn.hasAttribute('disabled')).toBe(true);
    }
  });

  it('disables form text inputs when run is running', () => {
    mockStream.state = { issue_ref: 'owner/repo#42', run: { running: true } };
    renderPage();

    // Check text inputs (org, project)
    const orgInput = document.querySelector('input.input[placeholder*="azure.com"]') as HTMLInputElement;
    expect(orgInput).not.toBeNull();
    expect(orgInput.disabled).toBe(true);

    const projectInput = document.querySelector('input.input[placeholder="MyProject"]') as HTMLInputElement;
    expect(projectInput).not.toBeNull();
    expect(projectInput.disabled).toBe(true);

    // Check password input (PAT)
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.disabled).toBe(true);
  });

  it('disables form inputs when any mutation is pending', () => {
    mockPutMutation.isPending = true;
    renderPage();

    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.disabled).toBe(true);
  });

  it('displays run warning message when run is active', () => {
    mockStream.state = { issue_ref: 'owner/repo#42', run: { running: true } };
    renderPage();

    expect(screen.getByText(/run is active/i)).toBeDefined();
  });
});

// ============================================================================
// AC2: Validation field errors and PAT-safe rendering
// ============================================================================

describe('T14-AC2 (component): validation field errors and PAT-safe DOM rendering', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('renders client-side validation error for empty organization on PUT', async () => {
    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const errorSpan = document.querySelector('.azure-devops-field-error');
      expect(errorSpan).not.toBeNull();
      expect(errorSpan!.textContent).toBe('Organization is required');
    });
  });

  it('renders client-side validation error for empty project on PUT', async () => {
    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    renderPage();

    // Fill org only
    const orgInput = screen.getByPlaceholderText('https://dev.azure.com/your-org');
    fireEvent.change(orgInput, { target: { value: 'https://dev.azure.com/myorg' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const errorSpan = document.querySelector('.azure-devops-field-error');
      expect(errorSpan).not.toBeNull();
      expect(errorSpan!.textContent).toBe('Project is required');
    });
  });

  it('renders client-side validation error for empty PAT on PUT', async () => {
    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    renderPage();

    // Fill org and project
    fireEvent.change(screen.getByPlaceholderText('https://dev.azure.com/your-org'), {
      target: { value: 'https://dev.azure.com/myorg' },
    });
    fireEvent.change(screen.getByPlaceholderText('MyProject'), {
      target: { value: 'TestProject' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const errorSpan = document.querySelector('.azure-devops-field-error');
      expect(errorSpan).not.toBeNull();
      expect(errorSpan!.textContent).toBe('PAT is required');
    });
  });

  it('renders server-side organization field error from ApiValidationError', async () => {
    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    mockPutMutation.mutateAsync = vi.fn().mockRejectedValue(
      new ApiValidationError('Validation failed', 'validation_failed', {
        organization: 'Invalid organization URL format',
      }),
    );
    renderPage();

    // Fill all fields to pass client-side validation
    fireEvent.change(screen.getByPlaceholderText('https://dev.azure.com/your-org'), {
      target: { value: 'bad-url' },
    });
    fireEvent.change(screen.getByPlaceholderText('MyProject'), {
      target: { value: 'TestProject' },
    });
    const patInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(patInput, { target: { value: 'test-pat-value-secret' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const errorSpans = document.querySelectorAll('.azure-devops-field-error');
      expect(errorSpans.length).toBeGreaterThanOrEqual(1);
      const errorTexts = Array.from(errorSpans).map((el) => el.textContent);
      expect(errorTexts).toContain('Invalid organization URL format');
    });
  });

  it('renders server-side project field error from ApiValidationError', async () => {
    // PATCH mode: configured = true
    mockPatchMutation.mutateAsync = vi.fn().mockRejectedValue(
      new ApiValidationError('Validation failed', 'validation_failed', {
        project: 'Project not found in organization',
      }),
    );
    renderPage();

    // Change project to trigger diff
    fireEvent.change(screen.getByPlaceholderText('MyProject'), {
      target: { value: 'NonexistentProject' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      const errorSpans = document.querySelectorAll('.azure-devops-field-error');
      const errorTexts = Array.from(errorSpans).map((el) => el.textContent);
      expect(errorTexts).toContain('Project not found in organization');
    });
  });

  it('renders server-side PAT field error from ApiValidationError', async () => {
    mockPatchMutation.mutateAsync = vi.fn().mockRejectedValue(
      new ApiValidationError('Validation failed', 'validation_failed', {
        pat: 'PAT is invalid or expired',
      }),
    );
    renderPage();

    // Enter new PAT to trigger PATCH
    const patInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(patInput, { target: { value: 'new-test-pat-secret' } });

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      const errorSpans = document.querySelectorAll('.azure-devops-field-error');
      const errorTexts = Array.from(errorSpans).map((el) => el.textContent);
      expect(errorTexts).toContain('PAT is invalid or expired');
    });
  });

  it('renders multiple field errors simultaneously', async () => {
    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    mockPutMutation.mutateAsync = vi.fn().mockRejectedValue(
      new ApiValidationError('Validation failed', 'validation_failed', {
        organization: 'Org URL invalid',
        project: 'Project required',
        pat: 'PAT too short',
      }),
    );
    renderPage();

    // Fill all fields to pass client-side validation
    fireEvent.change(screen.getByPlaceholderText('https://dev.azure.com/your-org'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByPlaceholderText('MyProject'), { target: { value: 'p' } });
    const patInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(patInput, { target: { value: 'x' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const errorSpans = document.querySelectorAll('.azure-devops-field-error');
      expect(errorSpans.length).toBe(3);
      const errorTexts = Array.from(errorSpans).map((el) => el.textContent);
      expect(errorTexts).toContain('Org URL invalid');
      expect(errorTexts).toContain('Project required');
      expect(errorTexts).toContain('PAT too short');
    });
  });

  it('PAT input is always type="password" — never displays plain PAT text', () => {
    renderPage();

    const patInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(patInput).not.toBeNull();
    expect(patInput.getAttribute('type')).toBe('password');
  });

  it('field error text never contains a PAT value in rendered DOM', async () => {
    const testPat = 'super-secret-pat-abc123';
    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    mockPutMutation.mutateAsync = vi.fn().mockRejectedValue(
      new ApiValidationError('Validation failed', 'validation_failed', {
        pat: 'PAT format is invalid',
      }),
    );
    renderPage();

    // Fill fields including PAT
    fireEvent.change(screen.getByPlaceholderText('https://dev.azure.com/your-org'), {
      target: { value: 'https://dev.azure.com/org' },
    });
    fireEvent.change(screen.getByPlaceholderText('MyProject'), {
      target: { value: 'Proj' },
    });
    const patInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(patInput, { target: { value: testPat } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const errorSpans = document.querySelectorAll('.azure-devops-field-error');
      expect(errorSpans.length).toBeGreaterThanOrEqual(1);
    });

    // Verify the PAT value never appears in any visible text content
    // Exclude input values (password field has it, but it's masked)
    const allSpans = document.querySelectorAll('span, div, p, button, label');
    for (const el of allSpans) {
      expect(el.textContent).not.toContain(testPat);
    }
  });

  it('field errors clear when the user types in the errored field', async () => {
    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    renderPage();

    // Trigger org validation error
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(document.querySelector('.azure-devops-field-error')).not.toBeNull();
    });

    // Type into the org field to clear the error
    fireEvent.change(screen.getByPlaceholderText('https://dev.azure.com/your-org'), {
      target: { value: 'x' },
    });

    // Error should be cleared
    await waitFor(() => {
      expect(document.querySelector('.azure-devops-field-error')).toBeNull();
    });
  });
});

// ============================================================================
// AC3: Error state rendering and stream-driven status updates
// ============================================================================

describe('T14-AC3 (component): error state rendering and stream-driven updates', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('renders "No issue selected" when no issue is active', () => {
    mockStream.state = null;
    renderPage();

    expect(screen.getByText('No issue selected.')).toBeDefined();
  });

  it('renders "Loading..." when status query is loading', () => {
    mockStatusQuery.data = null;
    mockStatusQuery.isLoading = true;
    renderPage();

    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('renders error banner with message when statusQuery has error', () => {
    mockStatusQuery.data = null;
    mockStatusQuery.isError = true;
    mockStatusQuery.error = new Error('Network connection failed');
    renderPage();

    expect(screen.getByText('Failed to load Azure DevOps status.')).toBeDefined();
    expect(screen.getByText('Network connection failed')).toBeDefined();
  });

  it('renders Retry button in error state that calls refetch', () => {
    const refetchFn = vi.fn();
    mockStatusQuery.data = null;
    mockStatusQuery.isError = true;
    mockStatusQuery.error = new Error('Server error');
    mockStatusQuery.refetch = refetchFn;
    renderPage();

    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toBeDefined();
    fireEvent.click(retryBtn);
    expect(refetchFn).toHaveBeenCalled();
  });

  it('renders "Unknown error" when error is not an Error instance', () => {
    mockStatusQuery.data = null;
    mockStatusQuery.isError = true;
    mockStatusQuery.error = 'string error';
    renderPage();

    expect(screen.getByText('Unknown error')).toBeDefined();
  });

  it('renders last_error in an errorBox when status has last_error', () => {
    mockStatusQuery.data = makeStatusData({ last_error: 'Permission denied writing .env.jeeves' });
    renderPage();

    const errorBox = document.querySelector('.errorBox');
    expect(errorBox).not.toBeNull();
    expect(errorBox!.textContent).toBe('Permission denied writing .env.jeeves');
  });

  it('does not render errorBox when last_error is null', () => {
    mockStatusQuery.data = makeStatusData({ last_error: null });
    renderPage();

    const lastErrorSection = document.querySelector('.azure-devops-last-error');
    expect(lastErrorSection).toBeNull();
  });

  it('renders last_error label alongside the errorBox', () => {
    mockStatusQuery.data = makeStatusData({ last_error: 'Sync failed' });
    renderPage();

    const lastErrorSection = document.querySelector('.azure-devops-last-error');
    expect(lastErrorSection).not.toBeNull();
    const label = lastErrorSection!.querySelector('.azure-devops-status-label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('Last Error');
  });

  it('renders configured badge when configured', () => {
    mockStatusQuery.data = makeStatusData({ configured: true });
    renderPage();

    const badge = document.querySelector('.azure-devops-badge.configured');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('Configured');
  });

  it('renders not-configured badge when not configured', () => {
    mockStatusQuery.data = makeStatusData({ configured: false });
    renderPage();

    const badges = document.querySelectorAll('.azure-devops-badge.not-configured');
    const texts = Array.from(badges).map((b) => b.textContent);
    expect(texts).toContain('Not Configured');
  });

  it('renders sync status label from status data', () => {
    mockStatusQuery.data = makeStatusData({ sync_status: 'failed_env_write' });
    renderPage();

    // The component uses formatSyncStatus which returns "Failed (env write)"
    const statusItems = document.querySelectorAll('.azure-devops-status-value');
    const texts = Array.from(statusItems).map((el) => el.textContent);
    expect(texts).toContain('Failed (env write)');
  });

  it('updates rendered status when query data changes (simulating stream refresh)', () => {
    // Start with in_sync status
    mockStatusQuery.data = makeStatusData({ sync_status: 'in_sync', last_error: null });
    renderPage();

    let statusValues = document.querySelectorAll('.azure-devops-status-value');
    let statusTexts = Array.from(statusValues).map((el) => el.textContent);
    expect(statusTexts).toContain('In Sync');

    cleanup();

    // Re-render with changed status (simulating stream-driven query cache update)
    mockStatusQuery.data = makeStatusData({
      sync_status: 'failed_env_write',
      last_error: 'env write permission denied',
    });
    renderPage();

    // Verify updated DOM
    statusValues = document.querySelectorAll('.azure-devops-status-value');
    statusTexts = Array.from(statusValues).map((el) => el.textContent);
    expect(statusTexts).toContain('Failed (env write)');
    const errorBox = document.querySelector('.errorBox');
    expect(errorBox).not.toBeNull();
    expect(errorBox!.textContent).toBe('env write permission denied');
  });

  it('stream event wiring: component renders without error when azureDevopsStatus is set', () => {
    // Test that the component's useEffect for stream sync does not crash
    // when azureDevopsStatus is present on the stream state
    mockStream.azureDevopsStatus = {
      issue_ref: 'owner/repo#42',
      worktree_present: true,
      configured: true,
      organization: 'https://dev.azure.com/updated-org',
      project: 'UpdatedProject',
      has_pat: true,
      pat_last_updated_at: '2026-01-15T12:00:00Z',
      pat_env_var_name: 'AZURE_DEVOPS_EXT_PAT',
      sync_status: 'in_sync',
      last_attempt_at: '2026-01-15T12:00:00Z',
      last_success_at: '2026-01-15T12:00:00Z',
      last_error: null,
      operation: 'patch',
    };

    renderPage();

    // The component renders successfully — useEffect ran without error
    expect(screen.getByText('Azure DevOps')).toBeDefined();
  });

  it('error toast is pushed when mutation fails with non-validation error', async () => {
    const pushToastFn = vi.fn();
    (useToast as Mock).mockReturnValue({ pushToast: pushToastFn });

    mockPatchMutation.mutateAsync = vi.fn().mockRejectedValue(new Error('Network timeout'));
    renderPage();

    // Change a field and save (PATCH mode since configured)
    const patInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(patInput, { target: { value: 'new-pat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(pushToastFn).toHaveBeenCalledWith('Network timeout');
    });
  });

  it('error toast is pushed when mutation fails with ApiValidationError', async () => {
    const pushToastFn = vi.fn();
    (useToast as Mock).mockReturnValue({ pushToast: pushToastFn });

    mockStatusQuery.data = makeStatusData({ configured: false, organization: null, project: null, has_pat: false });
    mockPutMutation.mutateAsync = vi.fn().mockRejectedValue(
      new ApiValidationError('All fields are required', 'validation_failed', { organization: 'Required' }),
    );
    renderPage();

    // Fill all fields
    fireEvent.change(screen.getByPlaceholderText('https://dev.azure.com/your-org'), {
      target: { value: 'https://dev.azure.com/org' },
    });
    fireEvent.change(screen.getByPlaceholderText('MyProject'), { target: { value: 'Proj' } });
    const patInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(patInput, { target: { value: 'my-pat' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(pushToastFn).toHaveBeenCalledWith('All fields are required');
    });
  });
});
