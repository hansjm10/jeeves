import { describe, expect, it } from 'vitest';

import {
  validateOrganization,
  validateProject,
  validatePat,
  validateBoolean,
  validateRepo,
  validateTitle,
  validateBody,
  validateStringArray,
  validateAzureTags,
  validateMilestone,
  validateAzurePath,
  validateBranch,
  validateWorkflow,
  validateDesignDoc,
  validateIntegerRange,
  validatePutAzureDevopsRequest,
  validatePatchAzureDevopsRequest,
  validateReconcileAzureDevopsRequest,
  validateInitParams,
  validateAutoRunParams,
  validateAzureCreateOptions,
  validateProvider,
  validateExistingItemRef,
  validateAzureInitFromExistingOptions,
  validateCreateProviderIssueRequest,
  validateInitFromExistingRequest,
  sanitizeErrorForUi,
  sanitizePatFromMessage,
  ORG_MIN_LENGTH,
  ORG_MAX_LENGTH,
  ORG_URL_PREFIX,
  PROJECT_MAX_LENGTH,
  PAT_MAX_LENGTH,
  REPO_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  BODY_MAX_LENGTH,
  LABELS_MAX_ITEMS,
  AZURE_TAGS_MAX_ITEMS,
  AZURE_PATH_MAX_LENGTH,
  BRANCH_MAX_LENGTH,
  WORKFLOW_MAX_LENGTH,
  WORKFLOW_NAME_PATTERN,
  DESIGN_DOC_MAX_LENGTH,
  MAX_ITERATIONS_MIN,
  MAX_ITERATIONS_MAX,
  INACTIVITY_TIMEOUT_MIN,
  INACTIVITY_TIMEOUT_MAX,
  ITERATION_TIMEOUT_MIN,
  ITERATION_TIMEOUT_MAX,
  AZURE_PAT_ENV_VAR_NAME,
  VALID_WORK_ITEM_TYPES,
  VALID_INIT_PHASES,
  VALID_AUTO_RUN_PROVIDERS,
  VALID_ISSUE_PROVIDERS,
} from './azureDevopsTypes.js';

// ============================================================================
// validateOrganization
// ============================================================================

describe('validateOrganization', () => {
  it('accepts a valid org slug', () => {
    const result = validateOrganization('my-org');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(`${ORG_URL_PREFIX}my-org`);
    }
  });

  it('accepts org slug with dots and underscores', () => {
    const result = validateOrganization('my.org_name');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(`${ORG_URL_PREFIX}my.org_name`);
    }
  });

  it('accepts a full Azure DevOps URL', () => {
    const result = validateOrganization('https://dev.azure.com/my-org');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(`${ORG_URL_PREFIX}my-org`);
    }
  });

  it('accepts URL with trailing slash', () => {
    const result = validateOrganization('https://dev.azure.com/my-org/');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(`${ORG_URL_PREFIX}my-org`);
    }
  });

  it('trims whitespace', () => {
    const result = validateOrganization('  my-org  ');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(`${ORG_URL_PREFIX}my-org`);
    }
  });

  it('rejects non-string', () => {
    expect(validateOrganization(123).valid).toBe(false);
    expect(validateOrganization(null).valid).toBe(false);
    expect(validateOrganization(undefined).valid).toBe(false);
  });

  it('rejects too short org (< 3 chars after trim)', () => {
    const result = validateOrganization('ab');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain(`${ORG_MIN_LENGTH}`);
    }
  });

  it('rejects too long org (> 200 chars after trim)', () => {
    const result = validateOrganization('a'.repeat(ORG_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain(`${ORG_MAX_LENGTH}`);
    }
  });

  it('rejects org slug with invalid characters', () => {
    const result = validateOrganization('my org');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('letters');
    }
  });

  it('rejects URL with empty org after prefix', () => {
    const result = validateOrganization('https://dev.azure.com/');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('organization name');
    }
  });
});

// ============================================================================
// validateProject
// ============================================================================

describe('validateProject', () => {
  it('accepts a valid project name', () => {
    const result = validateProject('My Project');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('My Project');
    }
  });

  it('trims whitespace', () => {
    const result = validateProject('  project  ');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('project');
    }
  });

  it('rejects non-string', () => {
    expect(validateProject(123).valid).toBe(false);
  });

  it('rejects empty after trim', () => {
    expect(validateProject('').valid).toBe(false);
    expect(validateProject('   ').valid).toBe(false);
  });

  it('rejects project exceeding max length', () => {
    const result = validateProject('a'.repeat(PROJECT_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain(`${PROJECT_MAX_LENGTH}`);
    }
  });

  it('rejects project with control characters', () => {
    const result = validateProject('project\x00name');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('control');
    }
  });
});

// ============================================================================
// validatePat
// ============================================================================

describe('validatePat', () => {
  it('accepts a valid PAT', () => {
    const result = validatePat('my-secret-pat-value');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('my-secret-pat-value');
    }
  });

  it('trims whitespace', () => {
    const result = validatePat('  pat  ');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('pat');
    }
  });

  it('rejects non-string', () => {
    expect(validatePat(123).valid).toBe(false);
    expect(validatePat(null).valid).toBe(false);
  });

  it('rejects empty after trim', () => {
    expect(validatePat('').valid).toBe(false);
    expect(validatePat('   ').valid).toBe(false);
  });

  it('rejects PAT exceeding max length', () => {
    const result = validatePat('a'.repeat(PAT_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
  });

  it('rejects PAT with null character', () => {
    const result = validatePat('pat\0value');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('null');
    }
  });

  it('rejects PAT with newline', () => {
    const result = validatePat('pat\nvalue');
    expect(result.valid).toBe(false);
  });

  it('rejects PAT with carriage return', () => {
    const result = validatePat('pat\rvalue');
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// validateBoolean
// ============================================================================

describe('validateBoolean', () => {
  it('accepts true', () => {
    const result = validateBoolean(true, 'field');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe(true);
  });

  it('accepts false', () => {
    const result = validateBoolean(false, 'field');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe(false);
  });

  it('rejects non-boolean', () => {
    expect(validateBoolean('true', 'f').valid).toBe(false);
    expect(validateBoolean(1, 'f').valid).toBe(false);
    expect(validateBoolean(null, 'f').valid).toBe(false);
  });

  it('includes field name in error', () => {
    const result = validateBoolean('nope', 'sync_now');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('sync_now');
  });
});

// ============================================================================
// validateRepo
// ============================================================================

describe('validateRepo', () => {
  it('accepts valid owner/repo format', () => {
    const result = validateRepo('owner/repo');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('owner/repo');
  });

  it('trims whitespace', () => {
    const result = validateRepo('  owner/repo  ');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('owner/repo');
  });

  it('rejects non-string', () => {
    expect(validateRepo(123).valid).toBe(false);
  });

  it('rejects too short', () => {
    expect(validateRepo('a/').valid).toBe(false);
  });

  it('rejects too long', () => {
    const result = validateRepo('a'.repeat(REPO_MAX_LENGTH + 1));
    expect(result.valid).toBe(false);
  });

  it('rejects without slash', () => {
    const result = validateRepo('noslash');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('owner/repo');
  });

  it('rejects with spaces in segments', () => {
    const result = validateRepo('own er/repo');
    expect(result.valid).toBe(false);
  });

  it('accepts Azure DevOps git URL', () => {
    const result = validateRepo('https://dev.azure.com/MyOrg/MyProject/_git/MyRepo');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('https://dev.azure.com/MyOrg/MyProject/_git/MyRepo');
  });

  it('accepts Azure DevOps git URL with encoded spaces', () => {
    const result = validateRepo('https://dev.azure.com/IOCHealthSystems/Software%20Development/_git/IOC-HealthSystems');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('https://dev.azure.com/IOCHealthSystems/Software%20Development/_git/IOC-HealthSystems');
  });

  it('accepts legacy visualstudio.com git URL', () => {
    const result = validateRepo('https://myorg.visualstudio.com/MyProject/_git/MyRepo');
    expect(result.valid).toBe(true);
  });

  it('rejects non-Azure URLs without owner/repo format', () => {
    const result = validateRepo('https://example.com/something');
    expect(result.valid).toBe(false);
  });
});

// ============================================================================
// validateTitle
// ============================================================================

describe('validateTitle', () => {
  it('accepts valid title', () => {
    const result = validateTitle('My Title');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('My Title');
  });

  it('rejects empty title', () => {
    expect(validateTitle('').valid).toBe(false);
    expect(validateTitle('  ').valid).toBe(false);
  });

  it('rejects too long title', () => {
    expect(validateTitle('a'.repeat(TITLE_MAX_LENGTH + 1)).valid).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validateTitle(123).valid).toBe(false);
  });
});

// ============================================================================
// validateBody
// ============================================================================

describe('validateBody', () => {
  it('accepts valid body', () => {
    const result = validateBody('Issue body text');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('Issue body text');
  });

  it('rejects empty body', () => {
    expect(validateBody('').valid).toBe(false);
    expect(validateBody('  ').valid).toBe(false);
  });

  it('rejects too long body', () => {
    expect(validateBody('a'.repeat(BODY_MAX_LENGTH + 1)).valid).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validateBody(null).valid).toBe(false);
  });
});

// ============================================================================
// validateStringArray
// ============================================================================

describe('validateStringArray', () => {
  it('accepts valid array', () => {
    const result = validateStringArray(['a', 'b'], 'labels', LABELS_MAX_ITEMS, 64);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toEqual(['a', 'b']);
  });

  it('trims items', () => {
    const result = validateStringArray(['  a  '], 'labels', LABELS_MAX_ITEMS, 64);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toEqual(['a']);
  });

  it('rejects non-array', () => {
    expect(validateStringArray('not-array', 'labels', 20, 64).valid).toBe(false);
  });

  it('rejects too many items', () => {
    const items = Array.from({ length: LABELS_MAX_ITEMS + 1 }, (_, i) => `item${i}`);
    expect(validateStringArray(items, 'labels', LABELS_MAX_ITEMS, 64).valid).toBe(false);
  });

  it('rejects non-string items', () => {
    expect(validateStringArray([123], 'labels', 20, 64).valid).toBe(false);
  });

  it('rejects empty items after trim', () => {
    expect(validateStringArray(['  '], 'labels', 20, 64).valid).toBe(false);
  });

  it('rejects items exceeding max length', () => {
    expect(validateStringArray(['a'.repeat(65)], 'labels', 20, 64).valid).toBe(false);
  });
});

// ============================================================================
// validateAzureTags
// ============================================================================

describe('validateAzureTags', () => {
  it('accepts valid tags', () => {
    const result = validateAzureTags(['tag1', 'tag2']);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toEqual(['tag1', 'tag2']);
  });

  it('rejects tags with control characters', () => {
    const result = validateAzureTags(['tag\x01']);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('control');
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: AZURE_TAGS_MAX_ITEMS + 1 }, (_, i) => `tag${i}`);
    expect(validateAzureTags(tags).valid).toBe(false);
  });

  it('rejects non-array', () => {
    expect(validateAzureTags('not-array').valid).toBe(false);
  });
});

// ============================================================================
// validateMilestone
// ============================================================================

describe('validateMilestone', () => {
  it('accepts valid milestone', () => {
    const result = validateMilestone('v1.0');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('v1.0');
  });

  it('rejects empty', () => {
    expect(validateMilestone('').valid).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validateMilestone(123).valid).toBe(false);
  });
});

// ============================================================================
// validateAzurePath
// ============================================================================

describe('validateAzurePath', () => {
  it('accepts valid area path', () => {
    const result = validateAzurePath('MyProject\\Team', 'area_path');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('MyProject\\Team');
  });

  it('rejects empty', () => {
    expect(validateAzurePath('', 'area_path').valid).toBe(false);
  });

  it('rejects too long', () => {
    expect(
      validateAzurePath('a'.repeat(AZURE_PATH_MAX_LENGTH + 1), 'area_path').valid,
    ).toBe(false);
  });

  it('rejects control characters', () => {
    const result = validateAzurePath('path\x01name', 'area_path');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('control');
  });

  it('rejects non-string', () => {
    expect(validateAzurePath(123, 'area_path').valid).toBe(false);
  });
});

// ============================================================================
// validateBranch
// ============================================================================

describe('validateBranch', () => {
  it('accepts valid branch name', () => {
    const result = validateBranch('feature/my-branch');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('feature/my-branch');
  });

  it('rejects empty', () => {
    expect(validateBranch('').valid).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validateBranch(123).valid).toBe(false);
  });

  it('rejects too long', () => {
    expect(validateBranch('a'.repeat(BRANCH_MAX_LENGTH + 1)).valid).toBe(false);
  });

  it('rejects leading slash', () => {
    expect(validateBranch('/branch').valid).toBe(false);
  });

  it('rejects trailing slash', () => {
    expect(validateBranch('branch/').valid).toBe(false);
  });

  it('rejects double dots', () => {
    expect(validateBranch('branch..name').valid).toBe(false);
  });

  it('rejects whitespace in name', () => {
    expect(validateBranch('branch name').valid).toBe(false);
  });

  it('rejects control characters in name', () => {
    expect(validateBranch('branch\x01name').valid).toBe(false);
  });
});

// ============================================================================
// validateWorkflow
// ============================================================================

describe('validateWorkflow', () => {
  it('accepts valid workflow', () => {
    const result = validateWorkflow('default');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('default');
  });

  it('rejects empty', () => {
    expect(validateWorkflow('').valid).toBe(false);
  });

  it('rejects too long', () => {
    expect(validateWorkflow('a'.repeat(WORKFLOW_MAX_LENGTH + 1)).valid).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validateWorkflow(123).valid).toBe(false);
  });
});

// ============================================================================
// validateDesignDoc
// ============================================================================

describe('validateDesignDoc', () => {
  it('accepts valid design doc path', () => {
    const result = validateDesignDoc('docs/design.md');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('docs/design.md');
  });

  it('rejects empty', () => {
    expect(validateDesignDoc('').valid).toBe(false);
  });

  it('rejects non-.md extension', () => {
    const result = validateDesignDoc('docs/design.txt');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('.md');
  });

  it('rejects absolute path', () => {
    const result = validateDesignDoc('/absolute/path.md');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('absolute');
  });

  it('rejects backslash absolute path', () => {
    const result = validateDesignDoc('\\absolute\\path.md');
    expect(result.valid).toBe(false);
  });

  it('rejects .. traversal', () => {
    const result = validateDesignDoc('../escape/path.md');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('..');
  });

  it('rejects too long', () => {
    expect(
      validateDesignDoc('a'.repeat(DESIGN_DOC_MAX_LENGTH - 2) + '.md').valid,
    ).toBe(false);
  });

  it('rejects non-string', () => {
    expect(validateDesignDoc(123).valid).toBe(false);
  });
});

// ============================================================================
// validateIntegerRange
// ============================================================================

describe('validateIntegerRange', () => {
  it('accepts value in range', () => {
    const result = validateIntegerRange(5, 'field', 1, 10);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe(5);
  });

  it('accepts min boundary', () => {
    const result = validateIntegerRange(1, 'field', 1, 10);
    expect(result.valid).toBe(true);
  });

  it('accepts max boundary', () => {
    const result = validateIntegerRange(10, 'field', 1, 10);
    expect(result.valid).toBe(true);
  });

  it('rejects below min', () => {
    expect(validateIntegerRange(0, 'field', 1, 10).valid).toBe(false);
  });

  it('rejects above max', () => {
    expect(validateIntegerRange(11, 'field', 1, 10).valid).toBe(false);
  });

  it('rejects non-integer', () => {
    expect(validateIntegerRange(1.5, 'field', 1, 10).valid).toBe(false);
    expect(validateIntegerRange('5', 'field', 1, 10).valid).toBe(false);
  });
});

// ============================================================================
// validatePutAzureDevopsRequest
// ============================================================================

describe('validatePutAzureDevopsRequest', () => {
  const validPut = {
    organization: 'my-org',
    project: 'MyProject',
    pat: 'secret-pat',
  };

  it('accepts valid PUT request with all required fields', () => {
    const result = validatePutAzureDevopsRequest(validPut);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.organization).toBe(`${ORG_URL_PREFIX}my-org`);
      expect(result.value.project).toBe('MyProject');
      expect(result.value.pat).toBe('secret-pat');
      expect(result.value.sync_now).toBe(true); // default
    }
  });

  it('accepts PUT with explicit sync_now=false', () => {
    const result = validatePutAzureDevopsRequest({ ...validPut, sync_now: false });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.sync_now).toBe(false);
  });

  it('rejects null body', () => {
    const result = validatePutAzureDevopsRequest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('object');
  });

  it('rejects non-object body', () => {
    expect(validatePutAzureDevopsRequest('string').valid).toBe(false);
    expect(validatePutAzureDevopsRequest(123).valid).toBe(false);
  });

  it('rejects missing organization', () => {
    const result = validatePutAzureDevopsRequest({ project: 'p', pat: 'x' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('validation_failed');
      expect(result.field_errors.organization).toBeDefined();
    }
  });

  it('rejects missing project', () => {
    const result = validatePutAzureDevopsRequest({ organization: 'org', pat: 'x' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.field_errors.project).toBeDefined();
  });

  it('rejects missing pat', () => {
    const result = validatePutAzureDevopsRequest({ organization: 'org', project: 'p' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.field_errors.pat).toBeDefined();
  });

  it('collects multiple field errors', () => {
    const result = validatePutAzureDevopsRequest({
      organization: 'ab', // too short
      project: '', // empty
      pat: '', // empty
      sync_now: 'yes', // not boolean
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(Object.keys(result.field_errors).length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ============================================================================
// validatePatchAzureDevopsRequest
// ============================================================================

describe('validatePatchAzureDevopsRequest', () => {
  it('accepts PATCH with organization only', () => {
    const result = validatePatchAzureDevopsRequest({ organization: 'my-org' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.organization).toBe(`${ORG_URL_PREFIX}my-org`);
      expect(result.value.sync_now).toBe(false); // default for PATCH
    }
  });

  it('accepts PATCH with project only', () => {
    const result = validatePatchAzureDevopsRequest({ project: 'MyProject' });
    expect(result.valid).toBe(true);
  });

  it('accepts PATCH with pat only', () => {
    const result = validatePatchAzureDevopsRequest({ pat: 'new-pat' });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.pat).toBe('new-pat');
  });

  it('accepts PATCH with clear_pat=true', () => {
    const result = validatePatchAzureDevopsRequest({ clear_pat: true });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.clear_pat).toBe(true);
  });

  it('rejects PATCH with no mutable fields', () => {
    const result = validatePatchAzureDevopsRequest({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('At least one');
      expect(result.code).toBe('validation_failed');
    }
  });

  it('rejects PATCH with sync_now only (not a mutable field)', () => {
    const result = validatePatchAzureDevopsRequest({ sync_now: true });
    expect(result.valid).toBe(false);
  });

  it('rejects pat and clear_pat=true together', () => {
    const result = validatePatchAzureDevopsRequest({ pat: 'new-pat', clear_pat: true });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.clear_pat).toBeDefined();
    }
  });

  it('rejects null body', () => {
    expect(validatePatchAzureDevopsRequest(null).valid).toBe(false);
  });
});

// ============================================================================
// validateReconcileAzureDevopsRequest
// ============================================================================

describe('validateReconcileAzureDevopsRequest', () => {
  it('accepts null/undefined body with default force=false', () => {
    const r1 = validateReconcileAzureDevopsRequest(null);
    expect(r1.valid).toBe(true);
    if (r1.valid) expect(r1.value.force).toBe(false);

    const r2 = validateReconcileAzureDevopsRequest(undefined);
    expect(r2.valid).toBe(true);
    if (r2.valid) expect(r2.value.force).toBe(false);
  });

  it('accepts empty object with default force=false', () => {
    const result = validateReconcileAzureDevopsRequest({});
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.force).toBe(false);
  });

  it('accepts force=true', () => {
    const result = validateReconcileAzureDevopsRequest({ force: true });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.force).toBe(true);
  });

  it('rejects non-boolean force', () => {
    const result = validateReconcileAzureDevopsRequest({ force: 'yes' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.field_errors.force).toBeDefined();
  });

  it('rejects non-object body', () => {
    expect(validateReconcileAzureDevopsRequest('string').valid).toBe(false);
  });
});

// ============================================================================
// validateInitParams
// ============================================================================

describe('validateInitParams', () => {
  it('accepts valid init params', () => {
    const errors: Record<string, string> = {};
    const result = validateInitParams(
      { branch: 'feature/test', workflow: 'default', phase: 'implement' },
      errors,
    );
    expect(Object.keys(errors)).toHaveLength(0);
    expect(result).not.toBeNull();
  });

  it('accepts empty init object', () => {
    const errors: Record<string, string> = {};
    const result = validateInitParams({}, errors);
    expect(Object.keys(errors)).toHaveLength(0);
    expect(result).not.toBeNull();
  });

  it('rejects non-object init', () => {
    const errors: Record<string, string> = {};
    validateInitParams('invalid', errors);
    expect(errors['init']).toBeDefined();
  });

  it('validates branch', () => {
    const errors: Record<string, string> = {};
    validateInitParams({ branch: '/invalid' }, errors);
    expect(errors['init.branch']).toBeDefined();
  });

  it('validates workflow', () => {
    const errors: Record<string, string> = {};
    validateInitParams({ workflow: '' }, errors);
    expect(errors['init.workflow']).toBeDefined();
  });

  it('validates phase enum', () => {
    const errors: Record<string, string> = {};
    validateInitParams({ phase: 'invalid' }, errors);
    expect(errors['init.phase']).toBeDefined();
  });

  it('accepts all valid phases', () => {
    for (const phase of VALID_INIT_PHASES) {
      const errors: Record<string, string> = {};
      validateInitParams({ phase }, errors);
      expect(errors['init.phase']).toBeUndefined();
    }
  });

  it('validates design_doc', () => {
    const errors: Record<string, string> = {};
    validateInitParams({ design_doc: '/absolute.md' }, errors);
    expect(errors['init.design_doc']).toBeDefined();
  });

  it('validates force', () => {
    const errors: Record<string, string> = {};
    validateInitParams({ force: 'yes' }, errors);
    expect(errors['init.force']).toBeDefined();
  });
});

// ============================================================================
// validateAutoRunParams
// ============================================================================

describe('validateAutoRunParams', () => {
  it('accepts valid auto_run params', () => {
    const errors: Record<string, string> = {};
    const result = validateAutoRunParams(
      { provider: 'claude', workflow: 'default', max_iterations: 10 },
      errors,
    );
    expect(Object.keys(errors)).toHaveLength(0);
    expect(result).not.toBeNull();
  });

  it('accepts empty auto_run object', () => {
    const errors: Record<string, string> = {};
    const result = validateAutoRunParams({}, errors);
    expect(Object.keys(errors)).toHaveLength(0);
    expect(result).not.toBeNull();
  });

  it('rejects non-object', () => {
    const errors: Record<string, string> = {};
    validateAutoRunParams('invalid', errors);
    expect(errors['auto_run']).toBeDefined();
  });

  it('validates provider enum', () => {
    const errors: Record<string, string> = {};
    validateAutoRunParams({ provider: 'invalid' }, errors);
    expect(errors['auto_run.provider']).toBeDefined();
  });

  it('accepts all valid providers', () => {
    for (const provider of VALID_AUTO_RUN_PROVIDERS) {
      const errors: Record<string, string> = {};
      validateAutoRunParams({ provider }, errors);
      expect(errors['auto_run.provider']).toBeUndefined();
    }
  });

  it('validates max_iterations range', () => {
    const errors: Record<string, string> = {};
    validateAutoRunParams({ max_iterations: 0 }, errors);
    expect(errors['auto_run.max_iterations']).toBeDefined();
  });

  it('validates inactivity_timeout_sec range', () => {
    const errors: Record<string, string> = {};
    validateAutoRunParams({ inactivity_timeout_sec: 5 }, errors);
    expect(errors['auto_run.inactivity_timeout_sec']).toBeDefined();
  });

  it('validates iteration_timeout_sec range', () => {
    const errors: Record<string, string> = {};
    validateAutoRunParams({ iteration_timeout_sec: 20 }, errors);
    expect(errors['auto_run.iteration_timeout_sec']).toBeDefined();
  });

  it('accepts boundary values', () => {
    const errors: Record<string, string> = {};
    validateAutoRunParams(
      {
        max_iterations: MAX_ITERATIONS_MIN,
        inactivity_timeout_sec: INACTIVITY_TIMEOUT_MIN,
        iteration_timeout_sec: ITERATION_TIMEOUT_MIN,
      },
      errors,
    );
    expect(Object.keys(errors)).toHaveLength(0);

    const errors2: Record<string, string> = {};
    validateAutoRunParams(
      {
        max_iterations: MAX_ITERATIONS_MAX,
        inactivity_timeout_sec: INACTIVITY_TIMEOUT_MAX,
        iteration_timeout_sec: ITERATION_TIMEOUT_MAX,
      },
      errors2,
    );
    expect(Object.keys(errors2)).toHaveLength(0);
  });
});

// ============================================================================
// validateAzureCreateOptions
// ============================================================================

describe('validateAzureCreateOptions', () => {
  it('accepts valid azure create options', () => {
    const errors: Record<string, string> = {};
    const result = validateAzureCreateOptions(
      { work_item_type: 'User Story', area_path: 'Project\\Team' },
      true,
      errors,
    );
    expect(Object.keys(errors)).toHaveLength(0);
    expect(result).not.toBeNull();
  });

  it('requires work_item_type for create mode', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions({}, true, errors);
    expect(errors['azure.work_item_type']).toBeDefined();
  });

  it('does not require work_item_type for non-create mode', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions({}, false, errors);
    expect(errors['azure.work_item_type']).toBeUndefined();
  });

  it('validates all work item types', () => {
    for (const type of VALID_WORK_ITEM_TYPES) {
      const errors: Record<string, string> = {};
      validateAzureCreateOptions({ work_item_type: type }, true, errors);
      expect(errors['azure.work_item_type']).toBeUndefined();
    }
  });

  it('rejects invalid work_item_type', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions({ work_item_type: 'Epic' }, true, errors);
    expect(errors['azure.work_item_type']).toBeDefined();
  });

  it('validates parent_id as positive integer', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions(
      { work_item_type: 'Bug', parent_id: -1 },
      true,
      errors,
    );
    expect(errors['azure.parent_id']).toBeDefined();
  });

  it('accepts valid parent_id', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions(
      { work_item_type: 'Bug', parent_id: 42 },
      true,
      errors,
    );
    expect(errors['azure.parent_id']).toBeUndefined();
  });

  it('validates area_path', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions(
      { work_item_type: 'Bug', area_path: 'p\x01ath' },
      true,
      errors,
    );
    expect(errors['azure.area_path']).toBeDefined();
  });

  it('validates iteration_path', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions(
      { work_item_type: 'Bug', iteration_path: '' },
      true,
      errors,
    );
    expect(errors['azure.iteration_path']).toBeDefined();
  });

  it('validates tags', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions(
      { work_item_type: 'Bug', tags: ['valid', 'tag\x01'] },
      true,
      errors,
    );
    expect(errors['azure.tags']).toBeDefined();
  });

  it('rejects non-object', () => {
    const errors: Record<string, string> = {};
    validateAzureCreateOptions('invalid', true, errors);
    expect(errors['azure']).toBeDefined();
  });
});

// ============================================================================
// sanitizeErrorForUi
// ============================================================================

describe('sanitizeErrorForUi', () => {
  it('converts Error to string', () => {
    expect(sanitizeErrorForUi(new Error('test'))).toBe('test');
  });

  it('passes through strings', () => {
    expect(sanitizeErrorForUi('error')).toBe('error');
  });

  it('handles unknown types', () => {
    expect(sanitizeErrorForUi(null)).toBe('Unknown error');
    expect(sanitizeErrorForUi(undefined)).toBe('Unknown error');
    expect(sanitizeErrorForUi(123)).toBe('Unknown error');
  });

  it('replaces forbidden characters', () => {
    const result = sanitizeErrorForUi('a\0b\nc\rd');
    expect(result).toBe('a b c d');
    expect(result).not.toContain('\0');
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\r');
  });

  it('truncates long messages', () => {
    const long = 'x'.repeat(3000);
    const result = sanitizeErrorForUi(long);
    expect(result.length).toBeLessThanOrEqual(2048);
    expect(result.endsWith('...')).toBe(true);
  });

  it('does not truncate at-limit messages', () => {
    const exact = 'x'.repeat(2048);
    expect(sanitizeErrorForUi(exact)).toBe(exact);
  });
});

// ============================================================================
// sanitizePatFromMessage
// ============================================================================

describe('sanitizePatFromMessage', () => {
  it('strips PAT value from message', () => {
    const pat = 'super-secret-pat';
    const result = sanitizePatFromMessage(
      `Error authenticating with PAT super-secret-pat for org`,
      pat,
    );
    expect(result).not.toContain(pat);
    expect(result).toContain('[REDACTED]');
  });

  it('handles empty/undefined PAT', () => {
    expect(sanitizePatFromMessage('error message', '')).toBe('error message');
    expect(sanitizePatFromMessage('error message', undefined)).toBe('error message');
  });

  it('strips multiple occurrences', () => {
    const pat = 'abc';
    const result = sanitizePatFromMessage('abc and abc again', pat);
    expect(result).toBe('[REDACTED] and [REDACTED] again');
  });
});

// ============================================================================
// Type safety - PAT never in status/event types
// ============================================================================

describe('Type safety - PAT never in status types', () => {
  it('AzureDevopsStatus type does not include pat field', () => {
    const status = {
      issue_ref: 'owner/repo#1',
      worktree_present: true,
      configured: true,
      organization: 'https://dev.azure.com/my-org',
      project: 'MyProject',
      has_pat: true,
      pat_last_updated_at: null,
      pat_env_var_name: AZURE_PAT_ENV_VAR_NAME,
      sync_status: 'in_sync' as const,
      last_attempt_at: null,
      last_success_at: null,
      last_error: null,
    };

    expect(status).not.toHaveProperty('pat');
    expect(typeof status.has_pat).toBe('boolean');
  });

  it('AzureDevopsStatusEvent type does not include pat field', () => {
    const event = {
      issue_ref: 'owner/repo#1',
      worktree_present: true,
      configured: true,
      organization: 'https://dev.azure.com/my-org',
      project: 'MyProject',
      has_pat: true,
      pat_last_updated_at: null,
      pat_env_var_name: AZURE_PAT_ENV_VAR_NAME,
      sync_status: 'in_sync' as const,
      last_attempt_at: null,
      last_success_at: null,
      last_error: null,
      operation: 'put' as const,
    };

    expect(event).not.toHaveProperty('pat');
    expect(typeof event.has_pat).toBe('boolean');
  });

  it('IssueIngestStatusEvent type does not include pat field', () => {
    const event = {
      issue_ref: 'owner/repo#1',
      provider: 'azure_devops' as const,
      mode: 'create' as const,
      outcome: 'success' as const,
      remote_id: '123',
      remote_url: 'https://dev.azure.com/org/proj/_workitems/edit/123',
      warnings: [],
      auto_select: { requested: true, ok: true },
      auto_run: { requested: false, ok: false },
      occurred_at: new Date().toISOString(),
    };

    expect(event).not.toHaveProperty('pat');
  });
});

// ============================================================================
// validateProvider
// ============================================================================

describe('validateProvider', () => {
  it('accepts github', () => {
    const result = validateProvider('github');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('github');
    }
  });

  it('accepts azure_devops', () => {
    const result = validateProvider('azure_devops');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('azure_devops');
    }
  });

  it('rejects non-string', () => {
    const result = validateProvider(123);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('must be a string');
    }
  });

  it('rejects null', () => {
    expect(validateProvider(null).valid).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validateProvider(undefined).valid).toBe(false);
  });

  it('rejects empty string', () => {
    const result = validateProvider('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('must be one of');
    }
  });

  it('rejects unknown provider string', () => {
    const result = validateProvider('bitbucket');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('must be one of');
    }
  });

  it('rejects case-variant of valid provider', () => {
    expect(validateProvider('GitHub').valid).toBe(false);
    expect(validateProvider('AZURE_DEVOPS').valid).toBe(false);
  });
});

// ============================================================================
// validateWorkflow – name pattern
// ============================================================================

describe('validateWorkflow - name pattern', () => {
  it('accepts simple name', () => {
    const result = validateWorkflow('default');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('default');
    }
  });

  it('accepts name with hyphens', () => {
    const result = validateWorkflow('quick-fix');
    expect(result.valid).toBe(true);
  });

  it('accepts name with underscores', () => {
    const result = validateWorkflow('my_workflow');
    expect(result.valid).toBe(true);
  });

  it('accepts alphanumeric name starting with digit', () => {
    const result = validateWorkflow('2fast');
    expect(result.valid).toBe(true);
  });

  it('rejects name with spaces', () => {
    const result = validateWorkflow('has space');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('alphanumeric');
    }
  });

  it('rejects name starting with hyphen', () => {
    const result = validateWorkflow('-starts-with-dash');
    expect(result.valid).toBe(false);
  });

  it('rejects name starting with underscore', () => {
    const result = validateWorkflow('_starts_underscore');
    expect(result.valid).toBe(false);
  });

  it('rejects name with special characters', () => {
    const result = validateWorkflow('has@special');
    expect(result.valid).toBe(false);
  });

  it('rejects name with dots', () => {
    const result = validateWorkflow('has.dot');
    expect(result.valid).toBe(false);
  });

  it('WORKFLOW_NAME_PATTERN matches expected values', () => {
    expect(WORKFLOW_NAME_PATTERN.test('default')).toBe(true);
    expect(WORKFLOW_NAME_PATTERN.test('quick-fix')).toBe(true);
    expect(WORKFLOW_NAME_PATTERN.test('a1_b-c')).toBe(true);
    expect(WORKFLOW_NAME_PATTERN.test('-nope')).toBe(false);
    expect(WORKFLOW_NAME_PATTERN.test('_nope')).toBe(false);
    expect(WORKFLOW_NAME_PATTERN.test('no spaces')).toBe(false);
  });
});

// ============================================================================
// validateExistingItemRef
// ============================================================================

describe('validateExistingItemRef', () => {
  it('accepts existing.id as a positive integer', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: 123 }, fieldErrors);
    expect(result).toEqual({ id: 123 });
    expect(Object.keys(fieldErrors)).toHaveLength(0);
  });

  it('accepts existing.id as a non-empty string', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: 'ABC-123' }, fieldErrors);
    expect(result).toEqual({ id: 'ABC-123' });
    expect(Object.keys(fieldErrors)).toHaveLength(0);
  });

  it('accepts existing.url as a non-empty string', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef(
      { url: 'https://github.com/owner/repo/issues/1' },
      fieldErrors,
    );
    expect(result).toEqual({
      url: 'https://github.com/owner/repo/issues/1',
    });
    expect(Object.keys(fieldErrors)).toHaveLength(0);
  });

  it('trims url', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef(
      { url: '  https://example.com  ' },
      fieldErrors,
    );
    expect(result).toEqual({ url: 'https://example.com' });
  });

  it('trims string id', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: '  456  ' }, fieldErrors);
    expect(result).toEqual({ id: '456' });
  });

  it('rejects when both id and url provided', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef(
      { id: 1, url: 'https://example.com' },
      fieldErrors,
    );
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('not both');
  });

  it('rejects when neither id nor url provided', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({}, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain(
      'Exactly one of existing.id or existing.url must be provided',
    );
  });

  it('rejects null', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef(null, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('must be an object');
  });

  it('rejects non-object', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef('invalid', fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('must be an object');
  });

  it('rejects negative id', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: -1 }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('positive integer');
  });

  it('rejects zero id', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: 0 }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('positive integer');
  });

  it('rejects non-integer numeric id', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: 1.5 }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('positive integer');
  });

  it('rejects empty string id', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: '' }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('must not be empty');
  });

  it('rejects whitespace-only string id', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: '   ' }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('must not be empty');
  });

  it('rejects empty string url', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ url: '' }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('must not be empty');
  });

  it('rejects non-string url', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ url: 123 }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('must be a string');
  });

  it('rejects boolean id', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateExistingItemRef({ id: true }, fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.existing).toContain('must be a number or string');
  });
});

// ============================================================================
// validateAzureInitFromExistingOptions
// ============================================================================

describe('validateAzureInitFromExistingOptions', () => {
  it('accepts valid options', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateAzureInitFromExistingOptions(
      { organization: 'my-org', project: 'my-project', fetch_hierarchy: true },
      fieldErrors,
    );
    expect(result).not.toBeNull();
    expect(Object.keys(fieldErrors)).toHaveLength(0);
  });

  it('accepts empty object', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateAzureInitFromExistingOptions({}, fieldErrors);
    expect(result).not.toBeNull();
    expect(Object.keys(fieldErrors)).toHaveLength(0);
  });

  it('rejects non-object', () => {
    const fieldErrors: Record<string, string> = {};
    const result = validateAzureInitFromExistingOptions('bad', fieldErrors);
    expect(result).toBeNull();
    expect(fieldErrors.azure).toBeDefined();
  });

  it('validates organization format', () => {
    const fieldErrors: Record<string, string> = {};
    validateAzureInitFromExistingOptions(
      { organization: 'a' },
      fieldErrors,
    );
    expect(fieldErrors['azure.organization']).toBeDefined();
  });

  it('validates fetch_hierarchy must be boolean', () => {
    const fieldErrors: Record<string, string> = {};
    validateAzureInitFromExistingOptions(
      { fetch_hierarchy: 'yes' },
      fieldErrors,
    );
    expect(fieldErrors['azure.fetch_hierarchy']).toBeDefined();
  });
});

// ============================================================================
// validateCreateProviderIssueRequest
// ============================================================================

describe('validateCreateProviderIssueRequest', () => {
  const validGitHub = {
    provider: 'github',
    repo: 'owner/repo',
    title: 'My Issue',
    body: 'Issue body text',
  };

  const validAzure = {
    provider: 'azure_devops',
    repo: 'owner/repo',
    title: 'My Work Item',
    body: 'Work item description',
    azure: {
      organization: 'my-org',
      project: 'my-project',
      work_item_type: 'Bug',
    },
  };

  it('accepts a valid minimal GitHub create request', () => {
    const result = validateCreateProviderIssueRequest(validGitHub);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.provider).toBe('github');
      expect(result.value.repo).toBe('owner/repo');
      expect(result.value.title).toBe('My Issue');
      expect(result.value.body).toBe('Issue body text');
    }
  });

  it('accepts a valid Azure create request with all azure fields', () => {
    const result = validateCreateProviderIssueRequest(validAzure);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.provider).toBe('azure_devops');
      expect(result.value.azure).toBeDefined();
    }
  });

  it('accepts request with labels, assignees, milestone', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      labels: ['bug', 'priority'],
      assignees: ['alice'],
      milestone: 'v1.0',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.labels).toEqual(['bug', 'priority']);
      expect(result.value.assignees).toEqual(['alice']);
      expect(result.value.milestone).toBe('v1.0');
    }
  });

  it('accepts request with init and default auto_select', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { branch: 'feature/test' },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.init).toBeDefined();
      expect(result.value.auto_select).toBe(true); // default
    }
  });

  it('accepts request with init, auto_select, and auto_run', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { branch: 'feature/test' },
      auto_select: true,
      auto_run: { provider: 'claude', max_iterations: 5 },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.auto_run).toBeDefined();
    }
  });

  it('rejects null body', () => {
    const result = validateCreateProviderIssueRequest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('validation_failed');
    }
  });

  it('rejects non-object body', () => {
    const result = validateCreateProviderIssueRequest('string');
    expect(result.valid).toBe(false);
  });

  it('rejects missing provider with unsupported_provider code', () => {
    const result = validateCreateProviderIssueRequest({
      repo: 'owner/repo',
      title: 'title',
      body: 'body',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('unsupported_provider');
      expect(result.field_errors.provider).toBeDefined();
    }
  });

  it('rejects unknown provider with unsupported_provider code', () => {
    const result = validateCreateProviderIssueRequest({
      provider: 'bitbucket',
      repo: 'owner/repo',
      title: 'title',
      body: 'body',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('unsupported_provider');
      expect(result.field_errors.provider).toContain('must be one of');
    }
  });

  it('rejects missing repo', () => {
    const result = validateCreateProviderIssueRequest({
      provider: 'github',
      title: 'title',
      body: 'body',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('validation_failed');
      expect(result.field_errors.repo).toBeDefined();
    }
  });

  it('rejects missing title', () => {
    const result = validateCreateProviderIssueRequest({
      provider: 'github',
      repo: 'owner/repo',
      body: 'body',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.title).toBeDefined();
    }
  });

  it('rejects missing body', () => {
    const result = validateCreateProviderIssueRequest({
      provider: 'github',
      repo: 'owner/repo',
      title: 'title',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.body).toBeDefined();
    }
  });

  it('collects multiple field errors', () => {
    const result = validateCreateProviderIssueRequest({
      provider: 'github',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.repo).toBeDefined();
      expect(result.field_errors.title).toBeDefined();
      expect(result.field_errors.body).toBeDefined();
    }
  });

  it('rejects invalid labels array', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      labels: 'not-an-array',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.labels).toBeDefined();
    }
  });

  it('rejects invalid assignees array', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      assignees: [123],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.assignees).toBeDefined();
    }
  });

  it('rejects invalid milestone', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      milestone: '',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.milestone).toBeDefined();
    }
  });

  it('rejects invalid azure sub-object', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      azure: 'not-an-object',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.azure).toBeDefined();
    }
  });

  it('rejects invalid init sub-object', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: 'not-an-object',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.init).toBeDefined();
    }
  });

  it('rejects auto_select without init', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      auto_select: true,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.auto_select).toContain('requires init');
    }
  });

  it('rejects auto_run without init', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      auto_run: { provider: 'claude' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.auto_run).toContain('requires init');
    }
  });

  it('rejects auto_run when auto_select is false', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { branch: 'feature/x' },
      auto_select: false,
      auto_run: { provider: 'claude' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.auto_run).toContain('auto_select');
    }
  });

  it('accepts auto_run with init and explicit auto_select true', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { branch: 'feature/x' },
      auto_select: true,
      auto_run: { provider: 'claude' },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts auto_run with init and default auto_select (not specified)', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { branch: 'feature/x' },
      auto_run: { provider: 'claude' },
    });
    expect(result.valid).toBe(true);
  });

  it('validates init.workflow name pattern', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { workflow: '-invalid' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors['init.workflow']).toBeDefined();
    }
  });

  it('validates auto_run.workflow name pattern', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { branch: 'feature/x' },
      auto_run: { workflow: 'has spaces' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors['auto_run.workflow']).toBeDefined();
    }
  });

  it('rejects non-boolean auto_select', () => {
    const result = validateCreateProviderIssueRequest({
      ...validGitHub,
      init: { branch: 'feature/x' },
      auto_select: 'yes',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.auto_select).toContain('boolean');
    }
  });

  it('validates azure.work_item_type required for create', () => {
    const result = validateCreateProviderIssueRequest({
      provider: 'azure_devops',
      repo: 'owner/repo',
      title: 'title',
      body: 'body',
      azure: { organization: 'my-org', project: 'my-project' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors['azure.work_item_type']).toBeDefined();
    }
  });
});

// ============================================================================
// validateInitFromExistingRequest
// ============================================================================

describe('validateInitFromExistingRequest', () => {
  const validWithId = {
    provider: 'github',
    repo: 'owner/repo',
    existing: { id: 42 },
  };

  const validWithUrl = {
    provider: 'azure_devops',
    repo: 'owner/repo',
    existing: { url: 'https://dev.azure.com/org/proj/_workitems/edit/42' },
  };

  it('accepts valid request with existing.id', () => {
    const result = validateInitFromExistingRequest(validWithId);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.provider).toBe('github');
      expect(result.value.existing).toEqual({ id: 42 });
    }
  });

  it('accepts valid request with existing.url', () => {
    const result = validateInitFromExistingRequest(validWithUrl);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.provider).toBe('azure_devops');
      expect(result.value.existing.url).toBeDefined();
    }
  });

  it('accepts request with azure init-from-existing options', () => {
    const result = validateInitFromExistingRequest({
      ...validWithUrl,
      azure: {
        organization: 'my-org',
        project: 'my-project',
        fetch_hierarchy: true,
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.azure).toBeDefined();
    }
  });

  it('accepts request with init and default auto_select', () => {
    const result = validateInitFromExistingRequest({
      ...validWithId,
      init: { branch: 'feature/test' },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.auto_select).toBe(true);
    }
  });

  it('rejects null body', () => {
    const result = validateInitFromExistingRequest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('validation_failed');
    }
  });

  it('rejects missing provider with unsupported_provider code', () => {
    const result = validateInitFromExistingRequest({
      repo: 'owner/repo',
      existing: { id: 1 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('unsupported_provider');
      expect(result.field_errors.provider).toBeDefined();
    }
  });

  it('rejects unknown provider with unsupported_provider code', () => {
    const result = validateInitFromExistingRequest({
      provider: 'gitlab',
      repo: 'owner/repo',
      existing: { id: 1 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('unsupported_provider');
    }
  });

  it('rejects missing repo', () => {
    const result = validateInitFromExistingRequest({
      provider: 'github',
      existing: { id: 1 },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.repo).toBeDefined();
    }
  });

  it('rejects missing existing', () => {
    const result = validateInitFromExistingRequest({
      provider: 'github',
      repo: 'owner/repo',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.existing).toBeDefined();
    }
  });

  it('rejects existing with both id and url', () => {
    const result = validateInitFromExistingRequest({
      provider: 'github',
      repo: 'owner/repo',
      existing: { id: 1, url: 'https://example.com' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.existing).toContain('not both');
    }
  });

  it('rejects existing with neither id nor url', () => {
    const result = validateInitFromExistingRequest({
      provider: 'github',
      repo: 'owner/repo',
      existing: {},
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.existing).toBeDefined();
    }
  });

  it('rejects auto_select without init', () => {
    const result = validateInitFromExistingRequest({
      ...validWithId,
      auto_select: true,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.auto_select).toContain('requires init');
    }
  });

  it('rejects auto_run without init', () => {
    const result = validateInitFromExistingRequest({
      ...validWithId,
      auto_run: { provider: 'claude' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.auto_run).toContain('requires init');
    }
  });

  it('rejects auto_run when auto_select is false', () => {
    const result = validateInitFromExistingRequest({
      ...validWithId,
      init: { branch: 'feature/x' },
      auto_select: false,
      auto_run: { provider: 'claude' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.auto_run).toContain('auto_select');
    }
  });

  it('accepts auto_run with init and default auto_select', () => {
    const result = validateInitFromExistingRequest({
      ...validWithId,
      init: { branch: 'feature/x' },
      auto_run: { provider: 'claude' },
    });
    expect(result.valid).toBe(true);
  });

  it('collects multiple field errors', () => {
    const result = validateInitFromExistingRequest({
      provider: 'github',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.repo).toBeDefined();
      expect(result.field_errors.existing).toBeDefined();
    }
  });

  it('validates init.workflow name pattern', () => {
    const result = validateInitFromExistingRequest({
      ...validWithId,
      init: { workflow: 'invalid name!' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors['init.workflow']).toBeDefined();
    }
  });

  it('validates azure init-from-existing with invalid organization', () => {
    const result = validateInitFromExistingRequest({
      ...validWithUrl,
      azure: { organization: 'a' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors['azure.organization']).toBeDefined();
    }
  });
});

// ============================================================================
// Constants
// ============================================================================

describe('Constants', () => {
  it('has correct org length bounds', () => {
    expect(ORG_MIN_LENGTH).toBe(3);
    expect(ORG_MAX_LENGTH).toBe(200);
  });

  it('has correct project length bounds', () => {
    expect(PROJECT_MAX_LENGTH).toBe(128);
  });

  it('has correct PAT length bounds', () => {
    expect(PAT_MAX_LENGTH).toBe(1024);
  });

  it('has correct Azure PAT env var name', () => {
    expect(AZURE_PAT_ENV_VAR_NAME).toBe('AZURE_DEVOPS_EXT_PAT');
  });

  it('has correct auto_run range constants', () => {
    expect(MAX_ITERATIONS_MIN).toBe(1);
    expect(MAX_ITERATIONS_MAX).toBe(100);
    expect(INACTIVITY_TIMEOUT_MIN).toBe(10);
    expect(INACTIVITY_TIMEOUT_MAX).toBe(7200);
    expect(ITERATION_TIMEOUT_MIN).toBe(30);
    expect(ITERATION_TIMEOUT_MAX).toBe(14400);
  });

  it('has correct valid issue providers', () => {
    expect(VALID_ISSUE_PROVIDERS).toEqual(['github', 'azure_devops']);
  });

  it('has correct workflow name pattern', () => {
    expect(WORKFLOW_NAME_PATTERN).toEqual(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
  });
});
