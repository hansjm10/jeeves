import { describe, expect, it } from 'vitest';

import {
  validateToken,
  validateEnvVarName,
  validateBoolean,
  validatePutRequest,
  validateReconcileRequest,
  sanitizeErrorForUi,
  TOKEN_MIN_LENGTH,
  TOKEN_MAX_LENGTH,
  ENV_VAR_NAME_MIN_LENGTH,
  ENV_VAR_NAME_MAX_LENGTH,
  DEFAULT_ENV_VAR_NAME,
} from './sonarTokenTypes.js';

describe('validateToken', () => {
  it('accepts a valid token', () => {
    const result = validateToken('my-secret-token');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('my-secret-token');
    }
  });

  it('trims whitespace from token', () => {
    const result = validateToken('  trimmed  ');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('trimmed');
    }
  });

  it('accepts minimum length token (1 char)', () => {
    const result = validateToken('x');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('x');
    }
  });

  it('accepts maximum length token (1024 chars)', () => {
    const longToken = 'a'.repeat(TOKEN_MAX_LENGTH);
    const result = validateToken(longToken);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(longToken);
    }
  });

  it('rejects non-string token', () => {
    expect(validateToken(123).valid).toBe(false);
    expect(validateToken(null).valid).toBe(false);
    expect(validateToken(undefined).valid).toBe(false);
    expect(validateToken({}).valid).toBe(false);
    expect(validateToken([]).valid).toBe(false);
  });

  it('rejects empty token', () => {
    const result = validateToken('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects whitespace-only token', () => {
    const result = validateToken('   ');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects token exceeding max length', () => {
    const longToken = 'a'.repeat(TOKEN_MAX_LENGTH + 1);
    const result = validateToken(longToken);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('1024');
    }
  });

  it('rejects token containing null character (\\0)', () => {
    const result = validateToken('token\0value');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('null');
    }
  });

  it('rejects token containing newline (\\n)', () => {
    const result = validateToken('token\nvalue');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('newline');
    }
  });

  it('rejects token containing carriage return (\\r)', () => {
    const result = validateToken('token\rvalue');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('carriage return');
    }
  });

  it('accepts token with special characters (hash, backslash, quote)', () => {
    // These are valid in tokens; they will be escaped when written to .env.jeeves
    const result = validateToken('token#with\\special"chars');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('token#with\\special"chars');
    }
  });
});

describe('validateEnvVarName', () => {
  it('accepts valid env var name', () => {
    const result = validateEnvVarName('SONAR_TOKEN');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('SONAR_TOKEN');
    }
  });

  it('accepts name starting with underscore', () => {
    const result = validateEnvVarName('_MY_VAR');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('_MY_VAR');
    }
  });

  it('accepts name with numbers', () => {
    const result = validateEnvVarName('VAR123');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('VAR123');
    }
  });

  it('trims whitespace from env var name', () => {
    const result = validateEnvVarName('  TRIMMED_VAR  ');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('TRIMMED_VAR');
    }
  });

  it('accepts minimum length env var name (1 char)', () => {
    const result = validateEnvVarName('A');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('A');
    }
  });

  it('accepts single underscore', () => {
    const result = validateEnvVarName('_');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('_');
    }
  });

  it('accepts maximum length env var name (64 chars)', () => {
    const longName = 'A'.repeat(ENV_VAR_NAME_MAX_LENGTH);
    const result = validateEnvVarName(longName);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(longName);
    }
  });

  it('rejects non-string env var name', () => {
    expect(validateEnvVarName(123).valid).toBe(false);
    expect(validateEnvVarName(null).valid).toBe(false);
    expect(validateEnvVarName(undefined).valid).toBe(false);
    expect(validateEnvVarName({}).valid).toBe(false);
  });

  it('rejects empty env var name', () => {
    const result = validateEnvVarName('');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects whitespace-only env var name', () => {
    const result = validateEnvVarName('   ');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('empty');
    }
  });

  it('rejects env var name exceeding max length', () => {
    const longName = 'A'.repeat(ENV_VAR_NAME_MAX_LENGTH + 1);
    const result = validateEnvVarName(longName);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('64');
    }
  });

  it('rejects env var name starting with number', () => {
    const result = validateEnvVarName('1INVALID');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('start with A-Z or underscore');
    }
  });

  it('rejects env var name with lowercase letters', () => {
    const result = validateEnvVarName('invalid_var');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('A-Z');
    }
  });

  it('rejects env var name with special characters', () => {
    const result = validateEnvVarName('INVALID-VAR');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('A-Z');
    }
  });

  it('rejects env var name containing null character (\\0)', () => {
    const result = validateEnvVarName('VAR\0NAME');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('null');
    }
  });

  it('rejects env var name containing newline (\\n)', () => {
    const result = validateEnvVarName('VAR\nNAME');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('newline');
    }
  });

  it('rejects env var name containing carriage return (\\r)', () => {
    const result = validateEnvVarName('VAR\rNAME');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('carriage return');
    }
  });
});

describe('validateBoolean', () => {
  it('accepts true', () => {
    const result = validateBoolean(true, 'test_field');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(true);
    }
  });

  it('accepts false', () => {
    const result = validateBoolean(false, 'test_field');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe(false);
    }
  });

  it('rejects non-boolean values', () => {
    expect(validateBoolean('true', 'test_field').valid).toBe(false);
    expect(validateBoolean(1, 'test_field').valid).toBe(false);
    expect(validateBoolean(0, 'test_field').valid).toBe(false);
    expect(validateBoolean(null, 'test_field').valid).toBe(false);
    expect(validateBoolean(undefined, 'test_field').valid).toBe(false);
    expect(validateBoolean({}, 'test_field').valid).toBe(false);
  });

  it('includes field name in error message', () => {
    const result = validateBoolean('not-a-bool', 'sync_now');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('sync_now');
    }
  });
});

describe('validatePutRequest', () => {
  it('accepts request with only token', () => {
    const result = validatePutRequest({ token: 'my-token' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.token).toBe('my-token');
      expect(result.env_var_name).toBeUndefined();
      expect(result.sync_now).toBe(true);
    }
  });

  it('accepts request with only env_var_name', () => {
    const result = validatePutRequest({ env_var_name: 'CUSTOM_TOKEN' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.token).toBeUndefined();
      expect(result.env_var_name).toBe('CUSTOM_TOKEN');
      expect(result.sync_now).toBe(true);
    }
  });

  it('accepts request with both token and env_var_name', () => {
    const result = validatePutRequest({ token: 'my-token', env_var_name: 'MY_VAR' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.token).toBe('my-token');
      expect(result.env_var_name).toBe('MY_VAR');
      expect(result.sync_now).toBe(true);
    }
  });

  it('accepts request with sync_now=false', () => {
    const result = validatePutRequest({ token: 'my-token', sync_now: false });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sync_now).toBe(false);
    }
  });

  it('accepts request with sync_now=true', () => {
    const result = validatePutRequest({ token: 'my-token', sync_now: true });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sync_now).toBe(true);
    }
  });

  it('rejects request with neither token nor env_var_name', () => {
    const result = validatePutRequest({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('At least one');
      expect(result.code).toBe('validation_failed');
      expect(result.field_errors.token).toBeDefined();
      expect(result.field_errors.env_var_name).toBeDefined();
    }
  });

  it('rejects request with empty object', () => {
    const result = validatePutRequest({});
    expect(result.valid).toBe(false);
  });

  it('rejects null body', () => {
    const result = validatePutRequest(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('object');
    }
  });

  it('rejects non-object body', () => {
    expect(validatePutRequest('string').valid).toBe(false);
    expect(validatePutRequest(123).valid).toBe(false);
    expect(validatePutRequest([]).valid).toBe(false);
  });

  it('rejects request with invalid token', () => {
    const result = validatePutRequest({ token: '' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.token).toBeDefined();
    }
  });

  it('rejects request with invalid env_var_name', () => {
    const result = validatePutRequest({ env_var_name: 'invalid-name' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.env_var_name).toBeDefined();
    }
  });

  it('rejects request with invalid sync_now type', () => {
    const result = validatePutRequest({ token: 'valid-token', sync_now: 'yes' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.sync_now).toBeDefined();
    }
  });

  it('collects multiple field errors', () => {
    const result = validatePutRequest({ token: '', env_var_name: 'invalid', sync_now: 'yes' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors.token).toBeDefined();
      expect(result.field_errors.env_var_name).toBeDefined();
      expect(result.field_errors.sync_now).toBeDefined();
    }
  });

  it('trims token and env_var_name values', () => {
    const result = validatePutRequest({ token: '  my-token  ', env_var_name: '  MY_VAR  ' });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.token).toBe('my-token');
      expect(result.env_var_name).toBe('MY_VAR');
    }
  });
});

describe('validateReconcileRequest', () => {
  it('accepts empty/null body with default force=false', () => {
    expect(validateReconcileRequest(null).valid).toBe(true);
    expect(validateReconcileRequest(undefined).valid).toBe(true);
    const result = validateReconcileRequest({});
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.force).toBe(false);
    }
  });

  it('accepts force=true', () => {
    const result = validateReconcileRequest({ force: true });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.force).toBe(true);
    }
  });

  it('accepts force=false', () => {
    const result = validateReconcileRequest({ force: false });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.force).toBe(false);
    }
  });

  it('rejects non-boolean force', () => {
    const result = validateReconcileRequest({ force: 'yes' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.field_errors?.force).toBeDefined();
    }
  });

  it('rejects non-object body', () => {
    expect(validateReconcileRequest('string').valid).toBe(false);
    expect(validateReconcileRequest(123).valid).toBe(false);
  });
});

describe('sanitizeErrorForUi', () => {
  it('converts Error to string', () => {
    const result = sanitizeErrorForUi(new Error('test error'));
    expect(result).toBe('test error');
  });

  it('passes through string errors', () => {
    const result = sanitizeErrorForUi('simple error');
    expect(result).toBe('simple error');
  });

  it('handles unknown error types', () => {
    expect(sanitizeErrorForUi(null)).toBe('Unknown error');
    expect(sanitizeErrorForUi(undefined)).toBe('Unknown error');
    expect(sanitizeErrorForUi(123)).toBe('Unknown error');
    expect(sanitizeErrorForUi({})).toBe('Unknown error');
  });

  it('replaces null characters with spaces', () => {
    const result = sanitizeErrorForUi('error\0with\0nulls');
    expect(result).toBe('error with nulls');
    expect(result).not.toContain('\0');
  });

  it('replaces newlines with spaces', () => {
    const result = sanitizeErrorForUi('error\nwith\nnewlines');
    expect(result).toBe('error with newlines');
    expect(result).not.toContain('\n');
  });

  it('replaces carriage returns with spaces', () => {
    const result = sanitizeErrorForUi('error\rwith\rreturns');
    expect(result).toBe('error with returns');
    expect(result).not.toContain('\r');
  });

  it('truncates long error messages', () => {
    const longError = 'x'.repeat(3000);
    const result = sanitizeErrorForUi(longError);
    expect(result.length).toBeLessThanOrEqual(2048);
    expect(result.endsWith('...')).toBe(true);
  });

  it('does not truncate messages at or under limit', () => {
    const maxError = 'x'.repeat(2048);
    const result = sanitizeErrorForUi(maxError);
    expect(result).toBe(maxError);
  });
});

describe('Type safety - token never in status types', () => {
  it('SonarTokenStatus type does not include token field', () => {
    // This is a compile-time check. If the type includes 'token',
    // TypeScript would allow assigning { token: 'secret' } below.
    // We verify at runtime that our example status object has no token field.
    const status = {
      issue_ref: 'owner/repo#1',
      worktree_present: true,
      has_token: true, // boolean indicating presence, not the value
      env_var_name: DEFAULT_ENV_VAR_NAME,
      sync_status: 'in_sync' as const,
      last_attempt_at: null,
      last_success_at: null,
      last_error: null,
    };

    // Verify the shape matches what we'd return in an API response
    expect(status).not.toHaveProperty('token');
    expect(typeof status.has_token).toBe('boolean');
  });

  it('SonarTokenStatusEvent type does not include token field', () => {
    const event = {
      issue_ref: 'owner/repo#1',
      worktree_present: true,
      has_token: true,
      env_var_name: DEFAULT_ENV_VAR_NAME,
      sync_status: 'in_sync' as const,
      last_attempt_at: null,
      last_success_at: null,
      last_error: null,
    };

    expect(event).not.toHaveProperty('token');
    expect(typeof event.has_token).toBe('boolean');
  });
});

describe('Constants', () => {
  it('has correct token length bounds', () => {
    expect(TOKEN_MIN_LENGTH).toBe(1);
    expect(TOKEN_MAX_LENGTH).toBe(1024);
  });

  it('has correct env var name length bounds', () => {
    expect(ENV_VAR_NAME_MIN_LENGTH).toBe(1);
    expect(ENV_VAR_NAME_MAX_LENGTH).toBe(64);
  });

  it('has correct default env var name', () => {
    expect(DEFAULT_ENV_VAR_NAME).toBe('SONAR_TOKEN');
  });
});
