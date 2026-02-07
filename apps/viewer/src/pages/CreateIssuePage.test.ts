import { describe, expect, it } from 'vitest';

import {
  applyExpansionResult,
  restoreFromUndo,
  buildExpandRequestFromState,
  buildCreateProviderRequest,
  buildInitFromExistingRequest,
  formatHierarchySummary,
  parseIngestFieldErrors,
  type UndoState,
} from './CreateIssuePage.js';
import { ApiValidationError } from '../features/azureDevops/api.js';
import type { IngestHierarchy } from '../api/azureDevopsTypes.js';

/**
 * Tests for CreateIssuePage.tsx helper functions.
 *
 * These tests verify:
 * - Mutation request serialization (buildExpandRequestFromState)
 * - Apply/undo state transitions (applyExpansionResult, restoreFromUndo)
 * - Provider-aware request building (buildCreateProviderRequest, buildInitFromExistingRequest)
 * - Hierarchy rendering (formatHierarchySummary)
 * - Field error parsing (parseIngestFieldErrors)
 */

describe('buildExpandRequestFromState', () => {
  describe('summary handling', () => {
    it('trims summary whitespace', () => {
      const result = buildExpandRequestFromState('  test summary  ', undefined, undefined, undefined);
      expect(result.summary).toBe('test summary');
    });

    it('includes trimmed summary', () => {
      const result = buildExpandRequestFromState('Add feature', undefined, undefined, undefined);
      expect(result.summary).toBe('Add feature');
    });
  });

  describe('issue type handling', () => {
    it('includes issue_type when provided', () => {
      const result = buildExpandRequestFromState('Test', 'feature', undefined, undefined);
      expect(result.issue_type).toBe('feature');
    });

    it('handles all issue types', () => {
      const types = ['feature', 'bug', 'refactor'] as const;
      for (const type of types) {
        const result = buildExpandRequestFromState('Test', type, undefined, undefined);
        expect(result.issue_type).toBe(type);
      }
    });

    it('omits issue_type when undefined', () => {
      const result = buildExpandRequestFromState('Test', undefined, undefined, undefined);
      expect('issue_type' in result).toBe(false);
    });
  });

  describe('provider handling', () => {
    it('includes provider when provided', () => {
      const result = buildExpandRequestFromState('Test', undefined, 'codex', undefined);
      expect(result.provider).toBe('codex');
    });

    it('includes provider when set to claude (allows override to claude)', () => {
      const result = buildExpandRequestFromState('Test', undefined, 'claude', undefined);
      expect(result.provider).toBe('claude');
    });

    it('omits provider when undefined', () => {
      const result = buildExpandRequestFromState('Test', undefined, undefined, undefined);
      expect('provider' in result).toBe(false);
    });
  });

  describe('model handling', () => {
    it('includes model when provided', () => {
      const result = buildExpandRequestFromState('Test', undefined, undefined, 'gpt-4');
      expect(result.model).toBe('gpt-4');
    });
  });
});

describe('applyExpansionResult', () => {
  describe('basic application', () => {
    it('returns generated title and body as new values', () => {
      const result = applyExpansionResult(
        'old title',
        'old body',
        'generated title',
        'generated body',
      );

      expect(result.newTitle).toBe('generated title');
      expect(result.newBody).toBe('generated body');
    });

    it('stores current values in undo state', () => {
      const result = applyExpansionResult(
        'current title',
        'current body',
        'new title',
        'new body',
      );

      expect(result.undoState).not.toBeNull();
      expect(result.undoState?.title).toBe('current title');
      expect(result.undoState?.body).toBe('current body');
    });
  });

  describe('edge cases', () => {
    it('handles empty current values', () => {
      const result = applyExpansionResult('', '', 'generated', 'content');

      expect(result.newTitle).toBe('generated');
      expect(result.newBody).toBe('content');
      expect(result.undoState?.title).toBe('');
      expect(result.undoState?.body).toBe('');
    });

    it('preserves prior input with content', () => {
      const result = applyExpansionResult(
        'User typed title',
        'User wrote a detailed body with\nmultiple lines',
        'AI Title',
        'AI Body',
      );

      expect(result.undoState?.title).toBe('User typed title');
      expect(result.undoState?.body).toBe('User wrote a detailed body with\nmultiple lines');
    });
  });
});

describe('restoreFromUndo', () => {
  describe('successful restoration', () => {
    it('returns stored title and body when undo state exists', () => {
      const undoState: UndoState = { title: 'saved title', body: 'saved body' };
      const result = restoreFromUndo(undoState);

      expect(result).not.toBeNull();
      expect(result?.title).toBe('saved title');
      expect(result?.body).toBe('saved body');
    });

    it('preserves empty strings in undo state', () => {
      const undoState: UndoState = { title: '', body: '' };
      const result = restoreFromUndo(undoState);

      expect(result?.title).toBe('');
      expect(result?.body).toBe('');
    });
  });

  describe('null undo state', () => {
    it('returns null when undo state is null', () => {
      const result = restoreFromUndo(null);
      expect(result).toBeNull();
    });
  });
});

describe('apply/undo state transitions', () => {
  it('full cycle: initial -> apply -> undo', () => {
    const initialTitle = 'My Issue Title';
    const initialBody = 'This is my issue description.';

    const applyResult = applyExpansionResult(
      initialTitle,
      initialBody,
      'AI Generated Title',
      '## Summary\nAI generated description.',
    );

    expect(applyResult.newTitle).toBe('AI Generated Title');
    expect(applyResult.newBody).toBe('## Summary\nAI generated description.');
    expect(applyResult.undoState).toEqual({
      title: initialTitle,
      body: initialBody,
    });

    const undoResult = restoreFromUndo(applyResult.undoState);

    expect(undoResult).toEqual({
      title: initialTitle,
      body: initialBody,
    });
  });

  it('apply when fields are empty preserves empty undo state', () => {
    const applyResult = applyExpansionResult(
      '',
      '',
      'Generated Title',
      'Generated Body',
    );

    expect(applyResult.undoState?.title).toBe('');
    expect(applyResult.undoState?.body).toBe('');

    const undoResult = restoreFromUndo(applyResult.undoState);
    expect(undoResult?.title).toBe('');
    expect(undoResult?.body).toBe('');
  });

  it('multiple apply/undo cycles work correctly', () => {
    const first = applyExpansionResult('Original', 'Content', 'Gen1', 'Body1');
    expect(first.undoState?.title).toBe('Original');

    const restored1 = restoreFromUndo(first.undoState);
    expect(restored1?.title).toBe('Original');

    const second = applyExpansionResult(
      restored1?.title ?? '',
      restored1?.body ?? '',
      'Gen2',
      'Body2',
    );
    expect(second.newTitle).toBe('Gen2');
    expect(second.undoState?.title).toBe('Original');

    const restored2 = restoreFromUndo(second.undoState);
    expect(restored2?.title).toBe('Original');
    expect(restored2?.body).toBe('Content');
  });
});

describe('buildCreateProviderRequest', () => {
  const baseOptions = {
    init: false,
    autoSelect: false,
    autoRun: false,
    runProvider: 'claude' as const,
  };

  describe('GitHub create requests', () => {
    it('builds a basic GitHub create request', () => {
      const result = buildCreateProviderRequest('github', 'owner/repo', 'title', 'body', baseOptions);
      expect(result.provider).toBe('github');
      expect(result.repo).toBe('owner/repo');
      expect(result.title).toBe('title');
      expect(result.body).toBe('body');
      expect(result.azure).toBeUndefined();
    });

    it('includes labels and assignees', () => {
      const result = buildCreateProviderRequest('github', 'owner/repo', 'title', 'body', {
        ...baseOptions,
        labels: 'bug, ui',
        assignees: 'alice, bob',
        milestone: 'v1.0',
      });
      expect(result.labels).toEqual(['bug', 'ui']);
      expect(result.assignees).toEqual(['alice', 'bob']);
      expect(result.milestone).toBe('v1.0');
    });

    it('omits empty labels', () => {
      const result = buildCreateProviderRequest('github', 'owner/repo', 'title', 'body', {
        ...baseOptions,
        labels: '',
      });
      expect(result.labels).toBeUndefined();
    });

    it('trims repo and title', () => {
      const result = buildCreateProviderRequest('github', '  owner/repo  ', '  title  ', 'body', baseOptions);
      expect(result.repo).toBe('owner/repo');
      expect(result.title).toBe('title');
    });
  });

  describe('Azure create requests', () => {
    it('builds an Azure create request with azure options', () => {
      const result = buildCreateProviderRequest('azure_devops', 'owner/repo', 'title', 'body', {
        ...baseOptions,
        azureWorkItemType: 'Bug',
        azureAreaPath: 'MyProject\\Area',
        azureIterationPath: 'MyProject\\Sprint 1',
        azureTags: 'frontend, priority-high',
        azureParentId: '123',
        azureOrganization: 'https://dev.azure.com/myorg',
        azureProject: 'MyProject',
      });
      expect(result.provider).toBe('azure_devops');
      expect(result.azure).toBeDefined();
      expect(result.azure?.work_item_type).toBe('Bug');
      expect(result.azure?.area_path).toBe('MyProject\\Area');
      expect(result.azure?.iteration_path).toBe('MyProject\\Sprint 1');
      expect(result.azure?.tags).toEqual(['frontend', 'priority-high']);
      expect(result.azure?.parent_id).toBe(123);
      expect(result.azure?.organization).toBe('https://dev.azure.com/myorg');
      expect(result.azure?.project).toBe('MyProject');
    });

    it('omits empty azure fields', () => {
      const result = buildCreateProviderRequest('azure_devops', 'owner/repo', 'title', 'body', {
        ...baseOptions,
        azureWorkItemType: undefined,
        azureAreaPath: '',
      });
      expect(result.azure).toBeDefined();
      expect(result.azure?.work_item_type).toBeUndefined();
      expect(result.azure?.area_path).toBeUndefined();
    });
  });

  describe('init options', () => {
    it('includes init options when init is true', () => {
      const result = buildCreateProviderRequest('github', 'owner/repo', 'title', 'body', {
        ...baseOptions,
        init: true,
        autoSelect: true,
        autoRun: true,
        runProvider: 'codex',
      });
      expect(result.init).toEqual({});
      expect(result.auto_select).toBe(true);
      expect(result.auto_run).toEqual({ provider: 'codex' });
    });

    it('omits auto_run when autoSelect is false', () => {
      const result = buildCreateProviderRequest('github', 'owner/repo', 'title', 'body', {
        ...baseOptions,
        init: true,
        autoSelect: false,
        autoRun: true,
        runProvider: 'claude',
      });
      expect(result.init).toEqual({});
      expect(result.auto_select).toBe(false);
      expect(result.auto_run).toBeUndefined();
    });

    it('omits init/autoSelect/autoRun when init is false', () => {
      const result = buildCreateProviderRequest('github', 'owner/repo', 'title', 'body', baseOptions);
      expect(result.init).toBeUndefined();
      expect(result.auto_select).toBeUndefined();
      expect(result.auto_run).toBeUndefined();
    });
  });
});

describe('buildInitFromExistingRequest', () => {
  const baseOptions = {
    init: false,
    autoSelect: false,
    autoRun: false,
    runProvider: 'claude' as const,
  };

  it('builds a GitHub init-from-existing request with numeric ID', () => {
    const result = buildInitFromExistingRequest('github', 'owner/repo', '42', baseOptions);
    expect(result.provider).toBe('github');
    expect(result.repo).toBe('owner/repo');
    expect(result.existing).toEqual({ id: 42 });
  });

  it('builds a request with URL reference', () => {
    const result = buildInitFromExistingRequest(
      'github',
      'owner/repo',
      'https://github.com/owner/repo/issues/42',
      baseOptions,
    );
    expect(result.existing).toEqual({ url: 'https://github.com/owner/repo/issues/42' });
  });

  it('builds an Azure init-from-existing request with azure options', () => {
    const result = buildInitFromExistingRequest('azure_devops', 'owner/repo', '12345', {
      ...baseOptions,
      azureOrganization: 'https://dev.azure.com/myorg',
      azureProject: 'MyProject',
      azureFetchHierarchy: true,
    });
    expect(result.provider).toBe('azure_devops');
    expect(result.existing).toEqual({ id: 12345 });
    expect(result.azure).toBeDefined();
    expect(result.azure?.organization).toBe('https://dev.azure.com/myorg');
    expect(result.azure?.project).toBe('MyProject');
    expect(result.azure?.fetch_hierarchy).toBe(true);
  });

  it('preserves azure fetch_hierarchy=false when explicitly disabled', () => {
    const result = buildInitFromExistingRequest('azure_devops', 'owner/repo', '12345', {
      ...baseOptions,
      azureOrganization: 'https://dev.azure.com/myorg',
      azureProject: 'MyProject',
      azureFetchHierarchy: false,
    });
    expect(result.azure).toBeDefined();
    expect(result.azure?.fetch_hierarchy).toBe(false);
  });

  it('treats non-numeric strings as string IDs', () => {
    const result = buildInitFromExistingRequest('github', 'owner/repo', 'abc-123', baseOptions);
    expect(result.existing).toEqual({ id: 'abc-123' });
  });

  it('trims whitespace from reference', () => {
    const result = buildInitFromExistingRequest('github', 'owner/repo', '  42  ', baseOptions);
    expect(result.existing).toEqual({ id: 42 });
  });

  it('includes init options when init is true', () => {
    const result = buildInitFromExistingRequest('github', 'owner/repo', '42', {
      ...baseOptions,
      init: true,
      autoSelect: true,
      autoRun: true,
      runProvider: 'fake',
    });
    expect(result.init).toEqual({});
    expect(result.auto_select).toBe(true);
    expect(result.auto_run).toEqual({ provider: 'fake' });
  });
});

describe('formatHierarchySummary', () => {
  it('returns null for undefined hierarchy', () => {
    expect(formatHierarchySummary(undefined)).toBeNull();
  });

  it('returns null when no parent and no children', () => {
    const hierarchy: IngestHierarchy = { parent: null, children: [] };
    expect(formatHierarchySummary(hierarchy)).toBeNull();
  });

  it('formats parent only', () => {
    const hierarchy: IngestHierarchy = {
      parent: { id: '1', title: 'Epic Task', url: 'https://example.com/1' },
      children: [],
    };
    expect(formatHierarchySummary(hierarchy)).toBe('Parent: Epic Task (#1)');
  });

  it('formats children only', () => {
    const hierarchy: IngestHierarchy = {
      parent: null,
      children: [
        { id: '2', title: 'Sub Task A', url: 'https://example.com/2' },
        { id: '3', title: 'Sub Task B', url: 'https://example.com/3' },
      ],
    };
    expect(formatHierarchySummary(hierarchy)).toBe('Children: Sub Task A (#2), Sub Task B (#3)');
  });

  it('formats parent and children together', () => {
    const hierarchy: IngestHierarchy = {
      parent: { id: '1', title: 'Epic', url: 'https://example.com/1' },
      children: [
        { id: '2', title: 'Sub A', url: 'https://example.com/2' },
      ],
    };
    expect(formatHierarchySummary(hierarchy)).toBe('Parent: Epic (#1) | Children: Sub A (#2)');
  });
});

describe('parseIngestFieldErrors', () => {
  it('returns field_errors from ApiValidationError', () => {
    const err = new ApiValidationError('Validation failed', 'validation_failed', {
      title: 'Title is required',
      body: 'Body is too short',
    });
    const result = parseIngestFieldErrors(err);
    expect(result).toEqual({
      title: 'Title is required',
      body: 'Body is too short',
    });
  });

  it('returns null for regular Error', () => {
    const err = new Error('Something went wrong');
    expect(parseIngestFieldErrors(err)).toBeNull();
  });

  it('returns null for non-Error values', () => {
    expect(parseIngestFieldErrors('string error')).toBeNull();
    expect(parseIngestFieldErrors(null)).toBeNull();
    expect(parseIngestFieldErrors(undefined)).toBeNull();
  });
});
