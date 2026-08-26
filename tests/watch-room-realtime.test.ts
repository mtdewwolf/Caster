import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { websocket } from 'hono/bun';
import { createWatchTogetherRouter } from '../apps/server/src/routes/watch-together';
import type { WatchRoomServerMessage } from '../apps/server/src/watch-together/contracts';
import {
  WatchRoomRealtimeHub,
  type WatchRoomRealtimePeer
} from '../apps/server/src/watch-together/realtime';
import { WatchRoomService } from '../apps/server/src/watch-together/room-service';

class FakePeer implements WatchRoomRealtimePeer {
  messages: WatchRoomServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string) {
    this.messages.push(JSON.parse(data) as WatchRoomServerMessage);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }

  take(type: WatchRoomServerMessage['type']) {
    return this.messages.filter((message) => message.type === type);
  }
}

function realtimeHarness(options: { maxMessagesPerWindow?: number } = {}) {
  let now = 1_000;
  let randomCall = 0;
  const service = new WatchRoomService({
    now: () => now,
    randomBytes: (size) => new Uint8Array(size).fill(++randomCall),
    roomTtlMs: 20_000,
    emptyRoomTtlMs: 5_000,
    reconnectGraceMs: 2_000
  });
  const hub = new WatchRoomRealtimeHub(service, {
    now: () => now,
    maxMessagesPerWindow: options.maxMessagesPerWindow ?? 30,
    rateWindowMs: 10_000,
    syncIntervalMs: 1_000
  });
  const created = service.createRoom({
    hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
  });
  service.joinRoom({
    roomId: created.roomId, userId: 'bob', inviteToken: created.inviteToken
  });
  return {
    service,
    hub,
    roomId: created.roomId,
    advance(milliseconds: number) { now += milliseconds; }
  };
}

describe('WatchRoomRealtimeHub', () => {
  it('sends snapshots and broadcasts host timeline commands while rejecting members', () => {
    const { hub, roomId } = realtimeHarness();
    const alice = new FakePeer();
    const bob = new FakePeer();
    hub.connect(roomId, 'alice', alice);
    hub.connect(roomId, 'bob', bob);

    expect(alice.take('snapshot')).toHaveLength(1);
    expect(bob.take('snapshot')).toHaveLength(1);
    hub.receive(roomId, 'alice', alice, JSON.stringify({
      type: 'command', action: 'play', positionSeconds: 12
    }));
    const bobTimeline = bob.take('timeline').at(-1);
    expect(bobTimeline).toMatchObject({
      type: 'timeline', cause: 'play', timeline: { paused: false, revision: 1 }
    });

    hub.receive(roomId, 'bob', bob, JSON.stringify({
      type: 'command', requestId: 'member-play', action: 'pause', positionSeconds: 12
    }));
    expect(bob.take('error').at(-1)).toMatchObject({
      type: 'error', code: 'HOST_ONLY', requestId: 'member-play'
    });
  });

  it('keeps preferences private, responds to ping, and rejects oversized or abusive clients', () => {
    const { hub, roomId } = realtimeHarness({ maxMessagesPerWindow: 2 });
    const alice = new FakePeer();
    const bob = new FakePeer();
    hub.connect(roomId, 'alice', alice);
    hub.connect(roomId, 'bob', bob);

    hub.receive(roomId, 'bob', bob, JSON.stringify({
      type: 'preferences', subtitleTrackIndex: 3, audioTrackIndex: 2
    }));
    expect(bob.take('preferences').at(-1)).toMatchObject({
      type: 'preferences', preferences: { subtitleTrackIndex: 3, audioTrackIndex: 2 }
    });
    expect(alice.take('preferences')).toHaveLength(0);

    hub.receive(roomId, 'bob', bob, JSON.stringify({ type: 'ping', clientTimeMs: 55 }));
    expect(bob.take('pong').at(-1)).toMatchObject({ type: 'pong', clientTimeMs: 55 });
    hub.receive(roomId, 'bob', bob, JSON.stringify({ type: 'ping', clientTimeMs: 56 }));
    expect(bob.closed?.code).toBe(1008);

    const replacement = new FakePeer();
    hub.connect(roomId, 'bob', replacement);
    hub.receive(roomId, 'bob', replacement, 'x'.repeat(9 * 1024));
    expect(replacement.closed?.code).toBe(1009);
  });

  it('promotes after host disconnect grace and closes every peer when the room expires', () => {
    const { hub, roomId, advance } = realtimeHarness();
    const alice = new FakePeer();
    const bob = new FakePeer();
    hub.connect(roomId, 'alice', alice);
    hub.connect(roomId, 'bob', bob);
    hub.disconnect(roomId, 'alice', alice);
    advance(2_000);
    hub.sweep();
    expect(bob.take('presence').at(-1)).toMatchObject({
      type: 'presence', hostUserId: 'bob'
    });

    advance(18_000);
    hub.sweep();
    expect(bob.closed).toEqual({ code: 4004, reason: 'Watch room expired' });
  });
});

const liveServers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of liveServers.splice(0)) server.stop(true);
});

describe('Watch Together WebSocket route', () => {
  it('upgrades an authenticated member and emits an initial snapshot', async () => {
    let randomCall = 0;
    const service = new WatchRoomService({
      randomBytes: (size) => new Uint8Array(size).fill(++randomCall)
    });
    const created = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
    });
    const hub = new WatchRoomRealtimeHub(service, { syncIntervalMs: 60_000 });
    const app = new Hono();
    app.route('/rooms', createWatchTogetherRouter({
      service,
      realtimeHub: hub,
      getUserId: (context) => context.req.query('test-user') || 'public',
      resolveMedia: (_context, mediaId) => mediaId === 'movie-1'
        ? { id: mediaId, duration: 100 }
        : null
    }));
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    liveServers.push(server);

    const message = await new Promise<WatchRoomServerMessage>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/rooms/${created.roomId}/ws?test-user=alice`
      );
      const timeout = setTimeout(() => reject(new Error('WebSocket snapshot timed out')), 3_000);
      socket.onmessage = (event) => {
        const parsed = JSON.parse(String(event.data)) as WatchRoomServerMessage;
        if (parsed.type !== 'snapshot') return;
        clearTimeout(timeout);
        socket.close();
        resolve(parsed);
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket upgrade failed'));
      };
    });
    expect(message).toMatchObject({
      type: 'snapshot', room: { roomId: created.roomId, self: { userId: 'alice', role: 'host' } }
    });
    hub.stop();
  });
});
