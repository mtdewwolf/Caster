import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Save, Wand2 } from 'lucide-react';
import { markerApi, type AdminMediaMarker, type MarkerAnalysisStatus } from './api';
import {
  formatMarkerTime,
  validateMarkerDraft,
  type MarkerEditorDraft,
  type MarkerEditorType
} from './editor-state';

interface MarkerEditorProps {
  mediaId: string;
  duration: number;
}

const MARKER_TYPES: readonly MarkerEditorType[] = ['intro', 'credits'];

function draftFor(marker: AdminMediaMarker | undefined): MarkerEditorDraft {
  return {
    enabled: marker?.state === 'active',
    start: formatMarkerTime(marker?.startSeconds),
    end: formatMarkerTime(marker?.endSeconds)
  };
}

export const MarkerEditor: React.FC<MarkerEditorProps> = ({ mediaId, duration }) => {
  const [markers, setMarkers] = useState<AdminMediaMarker[]>([]);
  const [drafts, setDrafts] = useState<Record<MarkerEditorType, MarkerEditorDraft>>({
    intro: draftFor(undefined),
    credits: draftFor(undefined)
  });
  const [analysis, setAnalysis] = useState<MarkerAnalysisStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<MarkerEditorType | 'analysis' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const applyMarkers = useCallback((items: AdminMediaMarker[]) => {
    setMarkers(items);
    setDrafts({
      intro: draftFor(items.find((marker) => marker.type === 'intro')),
      credits: draftFor(items.find((marker) => marker.type === 'credits'))
    });
  }, []);

  const load = useCallback(async () => {
    const result = await markerApi.getEditor(mediaId);
    applyMarkers(result.markers);
    setAnalysis(result.analysis);
  }, [applyMarkers, mediaId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    markerApi.getEditor(mediaId)
      .then((result) => {
        if (cancelled) return;
        applyMarkers(result.markers);
        setAnalysis(result.analysis);
      })
      .catch((error) => !cancelled && setMessage(error instanceof Error ? error.message : 'Unable to load markers'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [applyMarkers, mediaId]);

  useEffect(() => {
    if (analysis?.state !== 'queued' && analysis?.state !== 'running') return;
    const timer = window.setInterval(() => {
      markerApi.getAnalysisStatus(mediaId).then(({ status }) => {
        setAnalysis(status);
        if (status.state === 'completed') {
          void load().catch((error) => setMessage(error instanceof Error ? error.message : 'Unable to refresh markers'));
        }
      }).catch((error) => setMessage(error instanceof Error ? error.message : 'Unable to read analysis status'));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [analysis?.state, load, mediaId]);

  const validation = useMemo(() => ({
    intro: validateMarkerDraft(drafts.intro, duration),
    credits: validateMarkerDraft(drafts.credits, duration)
  }), [drafts, duration]);

  const changeDraft = (type: MarkerEditorType, changes: Partial<MarkerEditorDraft>) => {
    setDrafts((current) => ({ ...current, [type]: { ...current[type], ...changes } }));
    setMessage(null);
  };

  const save = async (type: MarkerEditorType) => {
    const result = validation[type];
    if (!result.valid || result.startSeconds === undefined || result.endSeconds === undefined) return;
    setBusy(type);
    setMessage(null);
    try {
      const response = await markerApi.putMarker(mediaId, type, {
        enabled: true,
        startSeconds: result.startSeconds,
        endSeconds: result.endSeconds
      });
      const next = [...markers.filter((marker) => marker.type !== type), response.marker];
      applyMarkers(next);
      setMessage(`${type === 'intro' ? 'Intro' : 'Credits'} marker saved.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save marker');
    } finally {
      setBusy(null);
    }
  };

  const disable = async (type: MarkerEditorType) => {
    setBusy(type);
    setMessage(null);
    try {
      const response = await markerApi.putMarker(mediaId, type, { enabled: false });
      const next = [...markers.filter((marker) => marker.type !== type), response.marker];
      applyMarkers(next);
      setMessage(`${type === 'intro' ? 'Intro' : 'Credits'} marker disabled.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to disable marker');
    } finally {
      setBusy(null);
    }
  };

  const analyze = async () => {
    setBusy('analysis');
    setMessage(null);
    try {
      const response = await markerApi.startAnalysis(mediaId);
      setAnalysis(response.status);
      setMessage(response.accepted ? 'Marker analysis queued.' : 'Marker analysis is already running.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to start analysis');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="bg-slate-950/60 border border-white/5 rounded-xl p-4 space-y-4" aria-label="Intro and credits markers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Intro & Credits</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">Times accept seconds, MM:SS, or HH:MM:SS.</p>
        </div>
        <button
          type="button"
          onClick={analyze}
          disabled={busy !== null || analysis?.state === 'queued' || analysis?.state === 'running'}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white"
        >
          {analysis?.state === 'queued' || analysis?.state === 'running'
            ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            : <Wand2 className="w-3.5 h-3.5" />}
          Analyze chapters
        </button>
      </div>

      {loading ? <div className="text-xs text-slate-500">Loading markers…</div> : (
        <div className="space-y-3">
          {MARKER_TYPES.map((type) => {
            const marker = markers.find((item) => item.type === type);
            const draft = drafts[type];
            const result = validation[type];
            return (
              <div key={type} className="grid grid-cols-1 sm:grid-cols-[90px_1fr_1fr_auto] gap-2 items-end">
                <div className="pb-2">
                  <div className="text-xs font-semibold text-slate-200 capitalize">{type}</div>
                  <div className="text-[10px] text-slate-500">
                    {marker?.state === 'disabled' ? 'Disabled' : marker ? marker.source : 'Not set'}
                  </div>
                </div>
                <label className="text-[10px] text-slate-500">
                  Start
                  <input
                    value={draft.start}
                    onChange={(event) => changeDraft(type, { enabled: true, start: event.target.value })}
                    placeholder="0:00"
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-white/10 px-2.5 py-2 text-xs text-slate-200 font-mono"
                  />
                </label>
                <label className="text-[10px] text-slate-500">
                  End
                  <input
                    value={draft.end}
                    onChange={(event) => changeDraft(type, { enabled: true, end: event.target.value })}
                    placeholder="1:30"
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-white/10 px-2.5 py-2 text-xs text-slate-200 font-mono"
                  />
                </label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    title={`Save ${type} marker`}
                    aria-label={`Save ${type} marker`}
                    disabled={
                      !draft.enabled || !result.valid ||
                      result.startSeconds === undefined || result.endSeconds === undefined ||
                      busy !== null
                    }
                    onClick={() => void save(type)}
                    className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white"
                  ><Save className="w-4 h-4" /></button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void disable(type)}
                    className="px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[11px] text-slate-300"
                  >Disable</button>
                </div>
                {!result.valid && draft.enabled ? (
                  <div className="sm:col-start-2 sm:col-span-3 text-[10px] text-rose-400">{result.error}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {analysis?.state === 'failed' || analysis?.state === 'timed_out' ? (
        <div className="text-[11px] text-rose-400">Analysis {analysis.state.replace('_', ' ')}: {analysis.error}</div>
      ) : null}
      {analysis?.state === 'completed' ? (
        <div className="text-[11px] text-emerald-400">
          Analysis complete{analysis.result ? ` · ${analysis.result.candidateCount} candidate(s)` : ''}.
        </div>
      ) : null}
      {message ? <div role="status" className="text-[11px] text-slate-300">{message}</div> : null}
    </section>
  );
};
