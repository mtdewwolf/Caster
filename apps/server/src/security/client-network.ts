function normalizedAddress(value: string): string {
  let address = value.trim().toLowerCase();
  if (address.startsWith('[')) {
    const closingBracket = address.indexOf(']');
    if (closingBracket > 0) address = address.slice(1, closingBracket);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'));
  }
  address = address.split('%')[0];
  if (address.startsWith('::ffff:') && ipv4Number(address.slice(7)) !== null) {
    address = address.slice(7);
  }
  return address;
}

function ipv4Number(value: string): number | null {
  const parts = value.trim().toLowerCase().split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return (((octets[0] * 0x1000000) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function ipv6Number(value: string): bigint | null {
  let address = normalizedAddress(value);
  if (!address.includes(':')) return null;

  const ipv4Match = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4 = ipv4Number(ipv4Match[1]);
    if (ipv4 === null) return null;
    address = `${address.slice(0, -ipv4Match[1].length)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  if ((address.match(/::/g) ?? []).length > 1) return null;
  const compressed = address.includes('::');
  const [leftText, rightText = ''] = address.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) return null;

  const groups = compressed
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(parseInt(group, 16));
  return result;
}

function parsedAddress(value: string): { version: 4 | 6; value: bigint } | null {
  const normalized = normalizedAddress(value);
  const ipv4 = ipv4Number(normalized);
  if (ipv4 !== null) return { version: 4, value: BigInt(ipv4) };
  const ipv6 = ipv6Number(normalized);
  return ipv6 === null ? null : { version: 6, value: ipv6 };
}

/** Match an IP against an exact IP or IPv4/IPv6 CIDR entry. */
export function addressMatchesNetwork(address: string, entry: string): boolean {
  const pieces = entry.trim().split('/');
  if (pieces.length > 2 || !pieces[0]) return false;
  const candidate = parsedAddress(address);
  const network = parsedAddress(pieces[0]);
  if (!candidate || !network || candidate.version !== network.version) return false;

  const totalBits = candidate.version === 4 ? 32 : 128;
  const prefix = pieces[1] === undefined ? totalBits : Number(pieces[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > totalBits) return false;
  if (prefix === 0) return true;
  const shift = BigInt(totalBits - prefix);
  return (candidate.value >> shift) === (network.value >> shift);
}

export function addressMatchesNetworks(address: string, configuredNetworks: string): boolean {
  return configuredNetworks
    .split(',')
    .some((entry) => entry.trim() && addressMatchesNetwork(address, entry));
}

function peerIsTrusted(peerAddress: string, configuredProxies: string): boolean {
  return addressMatchesNetworks(peerAddress, configuredProxies);
}

export function addressIsLocal(address: string): boolean {
  const normalized = normalizedAddress(address);
  if (normalized === 'localhost') return true;
  return [
    '127.0.0.0/8',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '::1/128',
    'fe80::/10',
    'fc00::/7'
  ].some((network) => addressMatchesNetwork(normalized, network));
}

export interface ClientNetworkInput {
  peerAddress?: string;
  forwardedFor?: string;
  realIp?: string;
  /** Presence of RFC 7239 Forwarded is detected but deliberately not parsed. */
  forwarded?: string;
  trustedProxies?: string;
}

/**
 * Resolve the client across an explicitly trusted proxy chain. The chain is
 * walked right-to-left so an attacker cannot prepend a spoofed private IP to
 * an existing X-Forwarded-For value. Unknown peers and malformed topology are
 * intentionally unresolved.
 */
export function effectiveClientAddress(input: ClientNetworkInput): string | null {
  const peer = input.peerAddress ? normalizedAddress(input.peerAddress) : '';
  if (!peer || !parsedAddress(peer)) return null;

  const hasForwarding = Boolean(input.forwardedFor || input.realIp || input.forwarded);
  if (!hasForwarding) return peer;
  if (!peerIsTrusted(peer, input.trustedProxies ?? '')) return null;

  // RFC 7239 has quoting/obfuscation rules that are easy to misinterpret. An
  // operator must configure their proxy to emit X-Forwarded-For or X-Real-IP.
  if (input.forwarded && !input.forwardedFor && !input.realIp) return null;

  const forwardedChain = input.forwardedFor
    ? input.forwardedFor.split(',').map((address) => normalizedAddress(address))
    : input.realIp ? [normalizedAddress(input.realIp)] : [];
  if (!forwardedChain.length || forwardedChain.some((address) => !parsedAddress(address))) return null;

  let current = peer;
  for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
    if (!peerIsTrusted(current, input.trustedProxies ?? '')) break;
    current = forwardedChain[index];
  }
  return current;
}

/** Classify unresolved or untrusted forwarding topology as remote. */
export function clientIsRemote(input: ClientNetworkInput): boolean {
  const address = effectiveClientAddress(input);
  return !address || !addressIsLocal(address);
}
