export function encodePathPreservingSlashes(pathLike: string): string {
  return pathLike
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export function wsUrlFromBaseUrl(baseUrl: string): string {
  const wsUrl = new URL('/api/ws', baseUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return wsUrl.toString();
}

export function decodePathPreservingSlashes(pathLike: string): string {
  return pathLike
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/');
}

