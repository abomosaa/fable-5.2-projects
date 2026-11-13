/**
 * Resolves where the game server lives.
 *
 * Order of precedence:
 *  1. `?ws=` query parameter (handy for pointing a local client at another server),
 *  2. the server's runtime `/config.json` (WS_PUBLIC_URL),
 *  3. the build-time `VITE_WS_URL`,
 *  4. same origin, path `/ws` (the default for the bundled server and the dev proxy).
 */
export interface ClientConfig {
  wsUrl: string;
  region: string;
  serverVersion: string;
}

function sameOriginWs(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}

function validWsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function loadClientConfig(): Promise<ClientConfig> {
  const config: ClientConfig = { wsUrl: sameOriginWs(), region: '', serverVersion: '' };
  const fromBuild = validWsUrl(import.meta.env.VITE_WS_URL);
  if (fromBuild) config.wsUrl = fromBuild;
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (response.ok) {
      const data: unknown = await response.json();
      if (typeof data === 'object' && data !== null) {
        const record = data as Record<string, unknown>;
        const fromServer = validWsUrl(record.wsUrl);
        if (fromServer) config.wsUrl = fromServer;
        if (typeof record.region === 'string') config.region = record.region.slice(0, 32);
        if (typeof record.version === 'string') config.serverVersion = record.version.slice(0, 32);
      }
    }
  } catch {
    // No runtime config (static hosting): fall back to the defaults above.
  }
  const fromQuery = validWsUrl(new URLSearchParams(location.search).get('ws'));
  if (fromQuery) config.wsUrl = fromQuery;
  return config;
}
