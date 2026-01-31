export async function apiJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
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
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

