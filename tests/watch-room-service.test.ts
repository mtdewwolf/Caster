import { describe, expect, it } from 'bun:test';
import { WatchRoomError } from '../apps/server/src/watch-together/contracts';
import { WatchRoomService } from '../apps/server/src/watch-together/room-service';

function harness(overrides: ConstructorParameters<typeof WatchRoomService>[0] = {}) {
  let now = 1_000;
  let randomCall = 0;
  const service = new WatchRoomService({
    now: () => now,
    randomBytes: (size) => {
      randomCall += 1;
      return new Uint8Array(size).fill(randomCall);
    },
    roomTtlMs: 60_000,
    emptyRoomTtlMs: 10_000,
    reconnectGraceMs: 3_000,
    ...overrides
  });
  return {
    service,
    advance(milliseconds: number) { now += milliseconds; },
    currentTime() { return now; }
  };
}

function expectCode(operation: () => unknown, code: WatchRoomError['code']) {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WatchRoomError);
    expect((error as WatchRoomError).code).toBe(code);
  }
}

describe('WatchRoomService', () => {
  it('creates an ephemeral room, verifies its secret, and returns member-scoped snapshots', () => {
    const { service } = harness();
    const created = service.createRoom({
      hostUserId: 'alice',
      mediaId: 'movie-1',
      durationSeconds: 120,
      positionSeconds: 12
    });

    expect(created.roomId).toStartWith('room_');
    expect(created.inviteToken.length).toBeGreaterThan(20);
    expect(created.snapshot.self).toMatchObject({
      userId: 'alice', role: 'host', connected: false,
      preferences: { audioTrackIndex: null, subtitleTrackIndex: null }
    });
    expectCode(() => service.joinRoom({
      roomId: created.roomId, userId: 'mallory', inviteToken: 'wrong'
    }), 'INVALID_INVITE');

    const bob = service.joinRoom({
      roomId: created.roomId, userId: 'bob', inviteToken: created.inviteToken
    });
    expect(bob.self.role).toBe('member');
    expect(bob.participants.map((participant) => participant.userId)).toEqual(['alice', 'bob']);
    expect(bob.participants.every((participant) => !('preferences' in participant))).toBe(true);
    expectCode(() => service.getMemberSnapshot(created.roomId, 'mallory'), 'NOT_MEMBER');
  });

  it('projects an authoritative timeline and restricts commands and reports to the host', () => {
    const { service, advance } = harness();
    const room = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
    });
    service.joinRoom({ roomId: room.roomId, userId: 'bob', inviteToken: room.inviteToken });

    const playing = service.applyCommand(room.roomId, 'alice', {
      action: 'play', positionSeconds: 10
    });
    expect(playing).toMatchObject({ paused: false, positionSeconds: 10, revision: 1 });
    advance(2_500);
    expect(service.getMemberSnapshot(room.roomId, 'bob').timeline.positionSeconds).toBe(12.5);

    expectCode(() => service.applyCommand(room.roomId, 'bob', {
      action: 'pause', positionSeconds: 12.5
    }), 'HOST_ONLY');

    const stale = service.applyHostReport(room.roomId, 'alice', {
      revision: 0, positionSeconds: 50, paused: false
    });
    expect(stale.accepted).toBe(false);
    expect(stale.timeline.positionSeconds).toBe(12.5);

    const accepted = service.applyHostReport(room.roomId, 'alice', {
      revision: 1, positionSeconds: 11.75, paused: true
    });
    expect(accepted).toMatchObject({
      accepted: true,
      timeline: { revision: 1, positionSeconds: 11.75, paused: true }
    });
    advance(2_000);
    expect(service.getMemberSnapshot(room.roomId, 'bob').timeline.positionSeconds).toBe(11.75);
  });

  it('keeps audio and subtitle preferences local to each participant', () => {
    const { service } = harness();
    const room = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
    });
    service.joinRoom({ roomId: room.roomId, userId: 'bob', inviteToken: room.inviteToken });
    const bob = service.updatePreferences(room.roomId, 'bob', {
      audioTrackIndex: 2,
      subtitleTrackIndex: 4
    });
    expect(bob.self.preferences).toEqual({ audioTrackIndex: 2, subtitleTrackIndex: 4 });
    expect(service.getMemberSnapshot(room.roomId, 'alice').self.preferences)
      .toEqual({ audioTrackIndex: null, subtitleTrackIndex: null });
    expectCode(() => service.updatePreferences(room.roomId, 'bob', {
      audioTrackIndex: -1
    }), 'INVALID_INPUT');
  });

  it('preserves the host through reconnect grace then promotes the longest-connected member', () => {
    const { service, advance } = harness();
    const room = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
    });
    service.connectMember(room.roomId, 'alice');
    advance(10);
    service.joinRoom({ roomId: room.roomId, userId: 'bob', inviteToken: room.inviteToken });
    service.connectMember(room.roomId, 'bob');
    advance(10);
    service.joinRoom({ roomId: room.roomId, userId: 'carol', inviteToken: room.inviteToken });
    service.connectMember(room.roomId, 'carol');

    service.disconnectMember(room.roomId, 'alice');
    advance(2_999);
    expect(service.getMemberSnapshot(room.roomId, 'bob').hostUserId).toBe('alice');
    service.connectMember(room.roomId, 'alice');
    service.disconnectMember(room.roomId, 'alice');
    advance(3_000);

    const promoted = service.getMemberSnapshot(room.roomId, 'bob');
    expect(promoted.hostUserId).toBe('bob');
    expect(promoted.self.role).toBe('host');
    expect(service.getMemberSnapshot(room.roomId, 'alice').self.role).toBe('member');
  });

  it('promotes immediately on host leave and removes an empty room or a host-closed room', () => {
    const { service } = harness();
    const room = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
    });
    service.joinRoom({ roomId: room.roomId, userId: 'bob', inviteToken: room.inviteToken });
    service.leaveRoom(room.roomId, 'alice');
    expect(service.getMemberSnapshot(room.roomId, 'bob').self.role).toBe('host');
    service.closeRoom(room.roomId, 'bob');
    expectCode(() => service.getMemberSnapshot(room.roomId, 'bob'), 'ROOM_NOT_FOUND');

    const solo = service.createRoom({
      hostUserId: 'carol', mediaId: 'movie-2', durationSeconds: 50
    });
    service.leaveRoom(solo.roomId, 'carol');
    expect(service.size).toBe(0);
  });

  it('expires empty and absolute-age rooms and frees host room limits', () => {
    const { service, advance } = harness({ maxRoomsPerHost: 1 });
    const empty = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
    });
    expectCode(() => service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-2', durationSeconds: 100
    }), 'ROOM_LIMIT_REACHED');
    advance(10_000);
    expect(service.cleanupExpired()).toEqual([empty.roomId]);

    const active = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-2', durationSeconds: 100
    });
    service.connectMember(active.roomId, 'alice');
    advance(60_000);
    expect(service.cleanupExpired()).toEqual([active.roomId]);
  });

  it('enforces participant capacity and rejects non-finite or out-of-range state', () => {
    const { service } = harness({ maxParticipants: 2 });
    expectCode(() => service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: Number.POSITIVE_INFINITY
    }), 'INVALID_INPUT');
    const room = service.createRoom({
      hostUserId: 'alice', mediaId: 'movie-1', durationSeconds: 100
    });
    service.joinRoom({ roomId: room.roomId, userId: 'bob', inviteToken: room.inviteToken });
    expectCode(() => service.joinRoom({
      roomId: room.roomId, userId: 'carol', inviteToken: room.inviteToken
    }), 'ROOM_FULL');
    expectCode(() => service.applyCommand(room.roomId, 'alice', {
      action: 'seek', positionSeconds: Number.NaN
    }), 'INVALID_INPUT');
    expectCode(() => service.applyHostReport(room.roomId, 'alice', {
      revision: 0, positionSeconds: 101, paused: false
    }), 'INVALID_INPUT');
  });
});
