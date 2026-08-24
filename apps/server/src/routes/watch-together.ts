import { Hono, type Context } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import type {
  UpdateWatchRoomPreferences,
  WatchRoomCommand,
  WatchRoomHostReport,
  WatchRoomSnapshot
} from '../watch-together/contracts';
import { WatchRoomError } from '../watch-together/contracts';
import { WatchRoomService } from '../watch-together/room-service';
import {
  WatchRoomRealtimeHub,
  type WatchRoomRealtimePeer
} from '../watch-together/realtime';

export interface AuthorizedWatchRoomMedia {
  id: string;
  duration: number;
}

export interface WatchTogetherRouterDependencies {
  /** Returns null when the request has no authenticated account principal. */
  getAuthenticatedUserId: (context: Context) => string | null;
  /**
   * Resolves media only when it is visible and streamable by the current
   * principal. Returning null deliberately makes denied media look missing.
   */
  resolveMedia: (
    context: Context,
    mediaId: string
  ) => AuthorizedWatchRoomMedia | null | Promise<AuthorizedWatchRoomMedia | null>;
  service?: WatchRoomService;
  realtimeHub?: WatchRoomRealtimeHub;
}

export const watchRoomService = new WatchRoomService();
export const watchRoomRealtimeHub = new WatchRoomRealtimeHub(watchRoomService);

function roomErrorResponse(context: Context, error: unknown): Response {
  if (!(error instanceof WatchRoomError)) throw error;
  switch (error.code) {
    case 'ROOM_NOT_FOUND':
    case 'INVALID_INVITE':
    case 'NOT_MEMBER':
      return context.json({ error: 'Watch room not found' }, 404);
    case 'HOST_ONLY':
      return context.json({ error: 'Only the room host may perform this action' }, 403);
    case 'INVALID_INPUT':
      return context.json({ error: error.message }, 400);
    case 'ROOM_FULL':
    case 'ROOM_LIMIT_REACHED':
      return context.json({ error: error.message }, 409);
  }
}

async function readObject(context: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json<unknown>();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function authenticatedUserId(
  context: Context,
  dependencies: WatchTogetherRouterDependencies
): string | Response {
  const userId = dependencies.getAuthenticatedUserId(context);
  return typeof userId === 'string' && userId.trim()
    ? userId
    : context.json({ error: 'Authentication required' }, 401);
}

async function mediaForMember(
  context: Context,
  dependencies: WatchTogetherRouterDependencies,
  service: WatchRoomService,
  roomId: string,
  userId: string
): Promise<{ room: WatchRoomSnapshot; media: AuthorizedWatchRoomMedia } | Response> {
  const room = service.getMemberSnapshot(roomId, userId);
  const media = await dependencies.resolveMedia(context, room.mediaId);
  return media ? { room, media } : context.json({ error: 'Watch room not found' }, 404);
}

/**
 * Creates a mount-point-agnostic REST router. The caller owns authentication
 * and ACL policy through the injected dependencies; this adapter never falls
 * back to open-mode or a synthetic user identity.
 */
export function createWatchTogetherRouter(
  dependencies: WatchTogetherRouterDependencies
): Hono {
  const router = new Hono();
  const service = dependencies.service ?? watchRoomService;
  const realtimeHub = dependencies.realtimeHub ?? (
    service === watchRoomService ? watchRoomRealtimeHub : new WatchRoomRealtimeHub(service)
  );
  realtimeHub.start();

  router.post('/', async (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    const body = await readObject(context);
    if (!body || typeof body.mediaId !== 'string') {
      return context.json({ error: 'mediaId is required' }, 400);
    }
    const media = await dependencies.resolveMedia(context, body.mediaId);
    if (!media) return context.json({ error: 'Media not found' }, 404);

    try {
      const created = service.createRoom({
        hostUserId: userId,
        mediaId: media.id,
        durationSeconds: media.duration,
        ...(body.positionSeconds === undefined
          ? {}
          : { positionSeconds: body.positionSeconds as number })
      });
      return context.json({
        roomId: created.roomId,
        inviteToken: created.inviteToken,
        room: created.snapshot
      }, 201);
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.post('/:id/join', async (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    const body = await readObject(context);
    if (!body || typeof body.inviteToken !== 'string') {
      return context.json({ error: 'inviteToken is required' }, 400);
    }

    try {
      // Authorization deliberately precedes invite verification. Possession of
      // a valid invitation never grants access to an otherwise denied title.
      const mediaId = service.getRoomMediaId(context.req.param('id'));
      const media = await dependencies.resolveMedia(context, mediaId);
      if (!media) return context.json({ error: 'Watch room not found' }, 404);
      const room = service.joinRoom({
        roomId: context.req.param('id'),
        userId,
        inviteToken: body.inviteToken
      });
      return context.json({ room });
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.get('/:id', async (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    try {
      const result = await mediaForMember(
        context, dependencies, service, context.req.param('id'), userId
      );
      if (result instanceof Response) return result;
      return context.json({ room: result.room });
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.get('/:id/ws', async (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    const roomId = context.req.param('id');
    try {
      const authorized = await mediaForMember(context, dependencies, service, roomId, userId);
      if (authorized instanceof Response) return authorized;

      let peer: WatchRoomRealtimePeer | null = null;
      return upgradeWebSocket(context, {
        onOpen: (_event, socket) => {
          peer = {
            send: (data) => socket.send(data),
            close: (code, reason) => socket.close(code, reason)
          };
          try {
            realtimeHub.connect(roomId, userId, peer);
          } catch {
            socket.close(4003, 'Watch room not found');
          }
        },
        onMessage: (event, socket) => {
          if (!peer) {
            socket.close(4003, 'Watch room connection is not active');
            return;
          }
          const data = event.data;
          if (typeof data === 'string' || data instanceof ArrayBuffer) {
            realtimeHub.receive(roomId, userId, peer, data);
          } else {
            socket.close(1003, 'Unsupported message data');
          }
        },
        onClose: () => {
          if (peer) realtimeHub.disconnect(roomId, userId, peer);
        },
        onError: () => {
          if (peer) realtimeHub.disconnect(roomId, userId, peer);
        }
      });
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.post('/:id/leave', (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    try {
      service.leaveRoom(context.req.param('id'), userId);
      realtimeHub.evictMember(context.req.param('id'), userId);
      return context.json({ success: true });
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.delete('/:id', (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    try {
      service.closeRoom(context.req.param('id'), userId);
      realtimeHub.closeConnections(context.req.param('id'));
      return context.json({ success: true });
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.post('/:id/commands', async (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    const body = await readObject(context);
    if (!body || (body.action !== 'play' && body.action !== 'pause' && body.action !== 'seek')) {
      return context.json({ error: 'A valid command action is required' }, 400);
    }
    try {
      const authorized = await mediaForMember(
        context, dependencies, service, context.req.param('id'), userId
      );
      if (authorized instanceof Response) return authorized;
      const timeline = service.applyCommand(context.req.param('id'), userId, {
        action: body.action,
        positionSeconds: body.positionSeconds as number
      } as WatchRoomCommand);
      return context.json({ timeline });
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.post('/:id/host-report', async (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    const body = await readObject(context);
    if (!body) return context.json({ error: 'A valid host report is required' }, 400);
    try {
      const authorized = await mediaForMember(
        context, dependencies, service, context.req.param('id'), userId
      );
      if (authorized instanceof Response) return authorized;
      const result = service.applyHostReport(context.req.param('id'), userId, {
        revision: body.revision as number,
        positionSeconds: body.positionSeconds as number,
        paused: body.paused as boolean
      } as WatchRoomHostReport);
      return context.json(result);
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  router.patch('/:id/preferences', async (context) => {
    const userId = authenticatedUserId(context, dependencies);
    if (userId instanceof Response) return userId;
    const body = await readObject(context);
    if (!body) return context.json({ error: 'Valid preferences are required' }, 400);
    try {
      const authorized = await mediaForMember(
        context, dependencies, service, context.req.param('id'), userId
      );
      if (authorized instanceof Response) return authorized;
      const update: UpdateWatchRoomPreferences = {
        ...(body.audioTrackIndex === undefined
          ? {}
          : { audioTrackIndex: body.audioTrackIndex as number | null }),
        ...(body.subtitleTrackIndex === undefined
          ? {}
          : { subtitleTrackIndex: body.subtitleTrackIndex as number | null })
      };
      const room = service.updatePreferences(context.req.param('id'), userId, update);
      return context.json({ room });
    } catch (error) {
      return roomErrorResponse(context, error);
    }
  });

  return router;
}
