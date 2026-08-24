import { describe, expect, it } from 'bun:test';
import {
  formatMarkerTime,
  parseMarkerTime,
  validateMarkerDraft
} from '../apps/web/src/features/markers/editor-state';

describe('marker editor state', () => {
  it('parses seconds and timestamp inputs deterministically', () => {
    expect(parseMarkerTime('90.5')).toBe(90.5);
    expect(parseMarkerTime('01:30')).toBe(90);
    expect(parseMarkerTime('1:02:03.5')).toBe(3723.5);
    expect(parseMarkerTime('1:60')).toBeNull();
    expect(parseMarkerTime('abc')).toBeNull();
    expect(formatMarkerTime(90.5)).toBe('1:30.5');
    expect(formatMarkerTime(3723)).toBe('1:02:03');
  });

  it('validates ordering and authoritative duration', () => {
    expect(validateMarkerDraft({ enabled: true, start: '0:10', end: '1:20' }, 1200))
      .toEqual({ valid: true, startSeconds: 10, endSeconds: 80 });
    expect(validateMarkerDraft({ enabled: true, start: '1:20', end: '1:20' }, 1200))
      .toMatchObject({ valid: false, error: 'End time must be after start time.' });
    expect(validateMarkerDraft({ enabled: true, start: '1', end: '1201' }, 1200))
      .toMatchObject({ valid: false, error: 'End time cannot exceed the episode duration.' });
    expect(validateMarkerDraft({ enabled: true, start: '', end: '10' }, 1200).valid).toBe(false);
    expect(validateMarkerDraft({ enabled: false, start: '', end: '' }, 1200)).toEqual({ valid: true });
  });
});
