import { describe, expect, it } from 'vitest';

import {
  normalizeProjectTargetPath,
  validateDeleteProjectFileId,
  validatePutProjectFileRequest,
  validateReconcileProjectFilesRequest,
} from './projectFilesTypes.js';

describe('projectFilesTypes', () => {
  describe('normalizeProjectTargetPath', () => {
    it('normalizes safe relative paths', () => {
      expect(normalizeProjectTargetPath(' configs\\local.json ')).toBe('configs/local.json');
    });

    it('rejects absolute, parent traversal, and .git paths', () => {
      expect(normalizeProjectTargetPath('/etc/passwd')).toBeNull();
      expect(normalizeProjectTargetPath('../secrets.txt')).toBeNull();
      expect(normalizeProjectTargetPath('.git/config')).toBeNull();
    });
  });

  describe('validatePutProjectFileRequest', () => {
    it('validates and decodes a valid payload', () => {
      const result = validatePutProjectFileRequest({
        target_path: 'configs/local.json',
        content_base64: Buffer.from('{"k":"v"}', 'utf-8').toString('base64'),
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.value.target_path).toBe('configs/local.json');
        expect(result.value.display_name).toBe('local.json');
        expect(result.value.sync_now).toBe(true);
      }
    });

    it('rejects invalid payloads with field errors', () => {
      const result = validatePutProjectFileRequest({
        target_path: '.git/config',
        content_base64: '***',
        sync_now: 'yes',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.field_errors.target_path).toBeTruthy();
        expect(result.field_errors.content_base64).toBeTruthy();
        expect(result.field_errors.sync_now).toBeTruthy();
      }
    });
  });

  describe('validateDeleteProjectFileId', () => {
    it('accepts safe ids and rejects invalid ids', () => {
      expect(validateDeleteProjectFileId('abc_123').valid).toBe(true);
      expect(validateDeleteProjectFileId('abc/123').valid).toBe(false);
    });
  });

  describe('validateReconcileProjectFilesRequest', () => {
    it('defaults force=false and accepts booleans', () => {
      const a = validateReconcileProjectFilesRequest(undefined);
      const b = validateReconcileProjectFilesRequest({ force: true });
      expect(a.valid && a.value.force).toBe(false);
      expect(b.valid && b.value.force).toBe(true);
    });
  });
});
