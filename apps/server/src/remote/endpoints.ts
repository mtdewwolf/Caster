import os from 'os';

export type EndpointKind = 'lan' | 'wan' | 'overlay' | 'relay';

export interface EndpointCandidate {
  kind: EndpointKind;
  url: string;
  priority: number;
  tls: boolean;
}

export interface EndpointCollectionOptions {
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  env?: Record<string, string | undefined>;
  port?: number;
}

const PRIORITY_LAN = 10;
const PRIORITY_OVERLAY = 20;
const PRIORITY_WAN = 30;
const PRIORITY_RELAY = 40;

function parsePort(value: string | undefined): number {
  const parsed = parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3001;
}

function isCgnatAddress(address: string): boolean {
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 100 && second >= 64 && second <= 127;
}

function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith('169.254.');
}

function normalizeAdvertisedUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export function collectEndpointCandidates(options: EndpointCollectionOptions = {}): EndpointCandidate[] {
  const env = options.env ?? process.env;
  const port = options.port ?? parsePort(env.PORT);
  const listInterfaces = options.interfaces ?? os.networkInterfaces;
  const candidates = new Map<string, EndpointCandidate>();

  for (const [name, addresses] of Object.entries(listInterfaces())) {
    if (!addresses) continue;
    for (const info of addresses) {
      if (info.internal || info.family !== 'IPv4') continue;
      if (isLinkLocalIpv4(info.address)) continue;
      const overlay = /tailscale/i.test(name) || isCgnatAddress(info.address);
      const kind: EndpointKind = overlay ? 'overlay' : 'lan';
      candidates.set(`http://${info.address}:${port}`, {
        kind,
        url: `http://${info.address}:${port}`,
        priority: overlay ? PRIORITY_OVERLAY : PRIORITY_LAN,
        tls: false
      });
    }
  }

  const advertisedUrl = env.CASTER_ADVERTISED_URL?.trim();
  if (advertisedUrl) {
    const url = normalizeAdvertisedUrl(advertisedUrl);
    if (url && !candidates.has(url.href.replace(/\/$/, ''))) {
      candidates.set(url.href.replace(/\/$/, ''), {
        kind: 'wan',
        url: url.href.replace(/\/$/, ''),
        priority: PRIORITY_WAN,
        tls: url.protocol === 'https:'
      });
    }
  }

  const tailscaleHost = env.CASTER_TAILSCALE_HOSTNAME?.trim().toLowerCase();
  if (tailscaleHost && tailscaleHost.endsWith('.ts.net')) {
    const scheme = env.CASTER_TAILSCALE_USE_HTTPS === 'true' ? 'https' : 'http';
    candidates.set(`${scheme}://${tailscaleHost}:${port}`, {
      kind: 'overlay',
      url: `${scheme}://${tailscaleHost}:${port}`,
      priority: PRIORITY_OVERLAY,
      tls: scheme === 'https'
    });
  }

  if (env.CASTER_RELAY_ENABLED === 'true') {
    const relayUrl = env.CASTER_RELAY_URL?.trim();
    const url = relayUrl ? normalizeAdvertisedUrl(relayUrl) : null;
    if (url) {
      candidates.set(url.href, {
        kind: 'relay',
        url: url.href,
        priority: PRIORITY_RELAY,
        tls: url.protocol === 'https:'
      });
    } else {
      candidates.set('relay://placeholder', {
        kind: 'relay',
        url: 'relay://placeholder',
        priority: PRIORITY_RELAY,
        tls: true
      });
    }
  }

  return [...candidates.values()].sort((left, right) =>
    left.priority - right.priority || left.kind.localeCompare(right.kind) || left.url.localeCompare(right.url)
  );
}
