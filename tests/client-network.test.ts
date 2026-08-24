import { describe, expect, it } from 'bun:test';
import {
  addressMatchesNetwork,
  clientIsRemote,
  effectiveClientAddress
} from '../apps/server/src/security/client-network';

describe('client network classification', () => {
  it('classifies direct LAN, loopback, and Internet peers conservatively', () => {
    expect(clientIsRemote({ peerAddress: '192.168.1.25' })).toBe(false);
    expect(clientIsRemote({ peerAddress: '::ffff:127.0.0.1' })).toBe(false);
    expect(clientIsRemote({ peerAddress: '203.0.113.25' })).toBe(true);
    expect(clientIsRemote({ peerAddress: '100.64.12.8' })).toBe(true);
  });

  it('does not trust a forwarded private address from an unconfigured peer', () => {
    expect(clientIsRemote({
      peerAddress: '172.20.0.4',
      forwardedFor: '192.168.1.25'
    })).toBe(true);
    expect(clientIsRemote({
      peerAddress: '203.0.113.25',
      realIp: '127.0.0.1',
      trustedProxies: '172.20.0.0/16'
    })).toBe(true);
  });

  it('honors forwarding headers only from an explicitly trusted proxy', () => {
    expect(clientIsRemote({
      peerAddress: '172.20.0.4',
      forwardedFor: '192.168.1.25, 172.20.0.3',
      trustedProxies: '172.20.0.0/16'
    })).toBe(false);
    expect(clientIsRemote({
      peerAddress: '172.20.0.4',
      forwardedFor: '203.0.113.25',
      trustedProxies: '172.20.0.4'
    })).toBe(true);
  });

  it('walks trusted proxy chains from the immediate peer instead of trusting the leftmost value', () => {
    expect(effectiveClientAddress({
      peerAddress: '10.0.0.3',
      forwardedFor: '127.0.0.1, 203.0.113.25, 10.0.0.2',
      trustedProxies: '10.0.0.0/24'
    })).toBe('203.0.113.25');
    expect(clientIsRemote({
      peerAddress: '10.0.0.3',
      forwardedFor: '127.0.0.1, 203.0.113.25, 10.0.0.2',
      trustedProxies: '10.0.0.0/24'
    })).toBe(true);

    expect(effectiveClientAddress({
      peerAddress: '10.0.0.3',
      forwardedFor: '192.168.1.25, 10.0.0.2',
      trustedProxies: '10.0.0.0/24'
    })).toBe('192.168.1.25');
  });

  it('normalizes socket forms and supports IPv4 and IPv6 proxy CIDRs', () => {
    expect(addressMatchesNetwork('::ffff:192.168.4.8', '192.168.0.0/16')).toBe(true);
    expect(addressMatchesNetwork('192.168.4.8:4412', '192.168.4.8')).toBe(true);
    expect(addressMatchesNetwork('[2001:db8:abcd::4]:443', '2001:db8:abcd::/48')).toBe(true);
    expect(addressMatchesNetwork('2001:db9::4', '2001:db8::/32')).toBe(false);

    expect(clientIsRemote({
      peerAddress: '[fd00:1234::2]:443',
      forwardedFor: '192.168.1.25',
      trustedProxies: 'fd00:1234::/64'
    })).toBe(false);
  });

  it('treats missing peer information and spoofable forwarding headers as remote', () => {
    expect(clientIsRemote({
      forwardedFor: '192.168.1.25',
      trustedProxies: '0.0.0.0/0'
    })).toBe(true);
    expect(clientIsRemote({})).toBe(true);
  });
});
