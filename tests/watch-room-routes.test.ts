import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  createWatchTogetherRouter,
  type AuthorizedWatchRoomMedia
} from '../apps/server/src/routes/watch-together';
import { WatchRoomService } from '../apps/server/src/watch-together/room-service';

interface CreatedRoomBody {
  roomId: string;
  inviteToken: string;
  room: { hostUserId: string; timeline: { revision: number; paused: boolean } };
}

function testApp(options: { maxParticipants?: number; maxRoomsPerHost?: number } = {}) {
  let randomCall = 0;
  const service = new WatchRoomService({
    randomBytes: (size) => new Uint8Array(size).fill(++randomCall),
    ...options
  });
  const media = new Map<string, AuthorizedWatchRoomMedia>([
    ['movie-1', { id: 'movie-1', duration: 120 }]
  ]);
  const denied = new Set<string>();
  const app = new Hono();
  app.route('/api/watch-rooms', createWatchTogetherRouter({
    service,
    getUserId: (context) => context.req.header('x-test-user') ?? 'public',
    resolveMedia: (context, mediaId) => {
      const userId = context.req.header('x-test-user') ?? 'public';
      return !denied.has(userId) ? media.get(mediaId) ?? null : null;
    }
  }));

  const request = (
    pathname: string,
    userId?: string,
    init: RequestInit & { json?: unknown } = {}
  ) => {
    const headers = new Headers(init.headers);
    if (userId) headers.set('x-test-user', userId);
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    return app.request(pathname, {
      ...init,
      headers,
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) })
    });
  };

  return { service, denied, request };
}

async function createRoom(
  request: ReturnType<typeof testApp>['request'],
  userId = 'alice'
): Promise<CreatedRoomBody> {
  const response = await request('/api/watch-rooms', userId, {
    method: 'POST', json: { mediaId: 'movie-1', positionSeconds: 5 }
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<CreatedRoomBody>;
}

describe('Watch Together REST router', () => {
  it('uses the injected shared identity and media resolver', async () => {
    const { denied, request } = testApp();
    expect((await request('/api/watch-rooms', undefined, {
      method: 'POST', json: { mediaId: 'movie-1' }
    })).status).toBe(201);
    expect((await request('/api/watch-rooms', 'alice', {
      method: 'POST', json: { mediaId: 'missing' }
    })).status).toBe(404);
    denied.add('alice');
    expect((await request('/api/watch-rooms', 'alice', {
      method: 'POST', json: { mediaId: 'movie-1' }
    })).status).toBe(404);
  });

  it('creates a room and admits only an authorized user with the secret', async () => {
    const { denied, request } = testApp();
    const created = await createRoom(request);
    expect(created.room).toMatchObject({
      hostUserId: 'alice', timeline: { revision: 0, paused: true }
    });

    const wrongSecret = await request(`/api/watch-rooms/${created.roomId}/join`, 'bob', {
      method: 'POST', json: { inviteToken: 'wrong' }
    });
    expect(wrongSecret.status).toBe(404);
    expect(await wrongSecret.json()).toEqual({ error: 'Watch room not found' });

    denied.add('mallory');
    expect((await request(`/api/watch-rooms/${created.roomId}/join`, 'mallory', {
      method: 'POST', json: { inviteToken: created.inviteToken }
    })).status).toBe(404);

    const joined = await request(`/api/watch-rooms/${created.roomId}/join`, 'bob', {
      method: 'POST', json: { inviteToken: created.inviteToken }
    });
    expect(joined.status).toBe(200);
    expect(await joined.json()).toMatchObject({ room: { self: { userId: 'bob', role: 'member' } } });

    expect((await request(`/api/watch-rooms/${created.roomId}`, 'carol')).status).toBe(404);
    expect((await request(`/api/watch-rooms/${created.roomId}`, 'bob')).status).toBe(200);
    denied.add('bob');
    expect((await request(`/api/watch-rooms/${created.roomId}`, 'bob')).status).toBe(404);
  });

  it('allows only the host to command the timeline and validates command values', async () => {
    const { request } = testApp();
    const created = await createRoom(request);
    await request(`/api/watch-rooms/${created.roomId}/join`, 'bob', {
      method: 'POST', json: { inviteToken: created.inviteToken }
    });

    expect((await request(`/api/watch-rooms/${created.roomId}/commands`, 'bob', {
      method: 'POST', json: { action: 'play', positionSeconds: 5 }
    })).status).toBe(403);
    expect((await request(`/api/watch-rooms/${created.roomId}/commands`, 'alice', {
      method: 'POST', json: { action: 'seek', positionSeconds: Number.POSITIVE_INFINITY }
    })).status).toBe(400);

    const command = await request(`/api/watch-rooms/${created.roomId}/commands`, 'alice', {
      method: 'POST', json: { action: 'play', positionSeconds: 20 }
    });
    expect(command.status).toBe(200);
    expect(await command.json()).toMatchObject({
      timeline: { paused: false, revision: 1 }
    });

    const staleReport = await request(`/api/watch-rooms/${created.roomId}/host-report`, 'alice', {
      method: 'POST', json: { revision: 0, positionSeconds: 21, paused: false }
    });
    expect(staleReport.status).toBe(200);
    expect(await staleReport.json()).toMatchObject({ accepted: false });
  });

  it('updates private preferences and supports leave and host close', async () => {
    const { request } = testApp();
    const created = await createRoom(request);
    await request(`/api/watch-rooms/${created.roomId}/join`, 'bob', {
      method: 'POST', json: { inviteToken: created.inviteToken }
    });

    const preferences = await request(
      `/api/watch-rooms/${created.roomId}/preferences`, 'bob', {
        method: 'PATCH', json: { audioTrackIndex: 2, subtitleTrackIndex: 3 }
      }
    );
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toMatchObject({
      room: { self: { preferences: { audioTrackIndex: 2, subtitleTrackIndex: 3 } } }
    });
    expect((await request(`/api/watch-rooms/${created.roomId}`, 'alice')).status).toBe(200);

    expect((await request(`/api/watch-rooms/${created.roomId}`, 'bob', {
      method: 'DELETE'
    })).status).toBe(403);
    expect((await request(`/api/watch-rooms/${created.roomId}/leave`, 'bob', {
      method: 'POST'
    })).status).toBe(200);
    expect((await request(`/api/watch-rooms/${created.roomId}`, 'alice', {
      method: 'DELETE'
    })).status).toBe(200);
    expect((await request(`/api/watch-rooms/${created.roomId}`, 'alice')).status).toBe(404);
  });

  it('maps participant and host room limits to conflict', async () => {
    const { request } = testApp({ maxParticipants: 1, maxRoomsPerHost: 1 });
    const created = await createRoom(request);
    expect((await request(`/api/watch-rooms/${created.roomId}/join`, 'bob', {
      method: 'POST', json: { inviteToken: created.inviteToken }
    })).status).toBe(409);
    expect((await request('/api/watch-rooms', 'alice', {
      method: 'POST', json: { mediaId: 'movie-1' }
    })).status).toBe(409);
  });
});
