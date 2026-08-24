export type MarkerEditorType = 'intro' | 'credits';

export interface MarkerEditorDraft {
  enabled: boolean;
  start: string;
  end: string;
}

export interface MarkerEditorValidation {
  valid: boolean;
  startSeconds?: number;
  endSeconds?: number;
  error?: string;
}

export function parseMarkerTime(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parts = normalized.split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;

  const numbers = parts.map(Number);
  let seconds = 0;
  for (const number of numbers) seconds = seconds * 60 + number;
  if (parts.length > 1 && numbers.slice(1).some((number) => number >= 60)) return null;
  return Number.isFinite(seconds) ? seconds : null;
}

export function formatMarkerTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.round((seconds % 60) * 1000) / 1000;
  const secondText = remainder.toString().padStart(2, '0');
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secondText}`
    : `${minutes}:${secondText}`;
}

export function validateMarkerDraft(
  draft: MarkerEditorDraft,
  duration: number
): MarkerEditorValidation {
  if (!draft.enabled) return { valid: true };
  const startSeconds = parseMarkerTime(draft.start);
  const endSeconds = parseMarkerTime(draft.end);
  if (startSeconds === null) return { valid: false, error: 'Enter a valid start time.' };
  if (endSeconds === null) return { valid: false, error: 'Enter a valid end time.' };
  if (endSeconds <= startSeconds) {
    return { valid: false, error: 'End time must be after start time.' };
  }
  if (duration > 0 && endSeconds > duration) {
    return { valid: false, error: 'End time cannot exceed the episode duration.' };
  }
  return { valid: true, startSeconds, endSeconds };
}
