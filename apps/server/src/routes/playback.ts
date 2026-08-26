import { Hono, type Context } from 'hono';
import {
  MediaMarkerStore,
  isMediaMarkerType,
  type MediaMarker
} from '../db/media-marker-store';
import {
  defaultMarkerAnalysisScheduler,
  MarkerAnalysisQueueFullError,
  MarkerAnalysisScheduler,
  type MarkerAnalysisInput,
  type MarkerAnalysisResult
} from '../markers';

type MaybePromise<T> = T | Promise<T>;

export interface PlaybackMedia {
  id: string;
  type: string;
  duration: number;
  full_path?: string;
}

export interface PlaybackRouterDependencies<TMedia extends PlaybackMedia = PlaybackMedia> {
  markerStore: MediaMarkerStore;

  /** Returns null when the requested media item does not exist. */
  resolveMedia: (context: Context, mediaId: string) => MaybePromise<TMedia | null>;

  /** Must apply the same library/rating scope and return a viewer-safe value. */
  resolveNextEpisode?: (context: Context, media: TMedia) => MaybePromise<unknown | null>;

  /** Optional injection point for tests or deployments with custom detectors. */
  analysisScheduler?: MarkerAnalysisScheduler<MarkerAnalysisInput, MarkerAnalysisResult>;
}

function playbackMarker(marker: MediaMarker) {
  return {
    type: marker.type,
    startSeconds: marker.startSeconds,
    endSeconds: marker.endSeconds,
    source: marker.source,
    confidence: marker.confidence
  };
}

async function readJsonObject(context: Context): Promise<Record<string, unknown> | null> {
  try {
    const value = await context.req.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function createPlaybackRouter<TMedia extends PlaybackMedia>(
  dependencies: PlaybackRouterDependencies<TMedia>
): Hono {
  const router = new Hono();
  const analysisScheduler = dependencies.analysisScheduler ?? defaultMarkerAnalysisScheduler;

  router.get('/:id/playback', async (context) => {
    const media = await dependencies.resolveMedia(context, context.req.param('id'));
    if (!media) return context.json({ error: 'Media not found' }, 404);

    const nextEpisode = media.type === 'episode' && dependencies.resolveNextEpisode
      ? await dependencies.resolveNextEpisode(context, media)
      : null;
    return context.json({
      markers: dependencies.markerStore.getActive(media.id).map(playbackMarker),
      nextEpisode
    });
  });

  router.put('/:id/markers/:type', async (context) => {
    const markerType = context.req.param('type');
    if (!isMediaMarkerType(markerType)) {
      return context.json({ error: 'Marker type must be intro or credits' }, 400);
    }

    const media = await dependencies.resolveMedia(context, context.req.param('id'));
    if (!media) return context.json({ error: 'Media not found' }, 404);
    if (media.type !== 'episode') {
      return context.json({ error: 'Playback markers are supported only for episodes' }, 400);
    }

    const body = await readJsonObject(context);
    if (!body) return context.json({ error: 'Invalid JSON body' }, 400);
    if (typeof body.enabled !== 'boolean') {
      return context.json({ error: 'enabled must be a boolean' }, 400);
    }

    if (!body.enabled) {
      const marker = dependencies.markerStore.disableManual(media.id, markerType);
      return context.json({ marker });
    }

    if (
      typeof body.startSeconds !== 'number' || !Number.isFinite(body.startSeconds) ||
      body.startSeconds < 0
    ) {
      return context.json({ error: 'startSeconds must be a non-negative finite number' }, 400);
    }
    if (
      typeof body.endSeconds !== 'number' || !Number.isFinite(body.endSeconds) ||
      body.endSeconds <= body.startSeconds
    ) {
      return context.json({ error: 'endSeconds must be greater than startSeconds' }, 400);
    }
    if (media.duration > 0 && body.endSeconds > media.duration) {
      return context.json({ error: 'endSeconds cannot exceed the media duration' }, 400);
    }

    const marker = dependencies.markerStore.upsertManual({
      mediaId: media.id,
      type: markerType,
      startSeconds: body.startSeconds,
      endSeconds: body.endSeconds
    });
    return context.json({ marker });
  });

  router.get('/:id/markers', async (context) => {
    const media = await dependencies.resolveMedia(context, context.req.param('id'));
    if (!media) return context.json({ error: 'Media not found' }, 404);
    if (media.type !== 'episode') {
      return context.json({ error: 'Playback markers are supported only for episodes' }, 400);
    }
    return context.json({
      markers: dependencies.markerStore.getAll(media.id),
      analysis: analysisScheduler.getStatus(media.id)
    });
  });

  router.post('/:id/markers/analysis', async (context) => {
    const media = await dependencies.resolveMedia(context, context.req.param('id'));
    if (!media) return context.json({ error: 'Media not found' }, 404);
    if (media.type !== 'episode') {
      return context.json({ error: 'Playback markers are supported only for episodes' }, 400);
    }
    if (!media.full_path) {
      return context.json({ error: 'The source path is unavailable for analysis' }, 409);
    }

    try {
      const queued = analysisScheduler.enqueue(media.id, {
        mediaId: media.id,
        fullPath: media.full_path,
        duration: media.duration
      });
      return context.json(queued, 202);
    } catch (error) {
      if (error instanceof MarkerAnalysisQueueFullError) {
        return context.json({ error: error.message }, 429);
      }
      throw error;
    }
  });

  router.get('/:id/markers/analysis', async (context) => {
    const media = await dependencies.resolveMedia(context, context.req.param('id'));
    if (!media) return context.json({ error: 'Media not found' }, 404);
    return context.json({
      status: analysisScheduler.getStatus(media.id) ?? {
        mediaId: media.id,
        state: 'idle'
      }
    });
  });

  return router;
}
