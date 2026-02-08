import type {
  ProjectFilesStatusResponse,
  ProjectFilesMutateResponse,
  ProjectFilesErrorResponse,
  PutProjectFileRequest,
  ReconcileProjectFilesRequest,
} from '../../api/projectFilesTypes.js';

export class ApiValidationError extends Error {
  readonly fieldErrors: Record<string, string>;
  readonly code: string;

  constructor(message: string, code: string, fieldErrors: Record<string, string>) {
    super(message);
    this.name = 'ApiValidationError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

async function apiJsonWithFieldErrors<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.method && init.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!res.ok) {
    const err = data as ProjectFilesErrorResponse | null;
    const message = err?.error ?? `Request failed (${res.status})`;
    const code = err?.code ?? 'unknown';
    const fieldErrors = err?.field_errors;
    if (fieldErrors && Object.keys(fieldErrors).length > 0) {
      throw new ApiValidationError(message, code, fieldErrors);
    }
    throw new Error(message);
  }

  return data as T;
}

export async function getProjectFilesStatus(baseUrl: string): Promise<ProjectFilesStatusResponse> {
  return apiJsonWithFieldErrors<ProjectFilesStatusResponse>(baseUrl, '/api/project-files');
}

export async function putProjectFile(
  baseUrl: string,
  request: PutProjectFileRequest,
): Promise<ProjectFilesMutateResponse> {
  return apiJsonWithFieldErrors<ProjectFilesMutateResponse>(baseUrl, '/api/project-files', {
    method: 'PUT',
    body: JSON.stringify(request),
  });
}

export async function deleteProjectFileById(
  baseUrl: string,
  id: string,
): Promise<ProjectFilesMutateResponse> {
  return apiJsonWithFieldErrors<ProjectFilesMutateResponse>(
    baseUrl,
    `/api/project-files/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export async function reconcileProjectFiles(
  baseUrl: string,
  request?: ReconcileProjectFilesRequest,
): Promise<ProjectFilesMutateResponse> {
  return apiJsonWithFieldErrors<ProjectFilesMutateResponse>(baseUrl, '/api/project-files/reconcile', {
    method: 'POST',
    body: request ? JSON.stringify(request) : undefined,
  });
}
