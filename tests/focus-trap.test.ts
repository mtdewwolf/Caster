import { describe, expect, it } from 'bun:test';
import {
  FOCUSABLE_SELECTOR,
  nextFocusIndex,
  shouldTrapTab
} from '../apps/web/src/features/a11y/focus-trap';

describe('modal focus containment', () => {
  it('moves forward through the dialog', () => {
    expect(nextFocusIndex(4, 0, false)).toBe(1);
    expect(nextFocusIndex(4, 2, false)).toBe(3);
  });

  it('wraps from the last control back to the first', () => {
    expect(nextFocusIndex(4, 3, false)).toBe(0);
  });

  it('moves backward and wraps on Shift+Tab', () => {
    expect(nextFocusIndex(4, 1, true)).toBe(0);
    expect(nextFocusIndex(4, 0, true)).toBe(3);
  });

  it('pulls focus back to the near edge when it escaped the dialog', () => {
    expect(nextFocusIndex(4, -1, false)).toBe(0);
    expect(nextFocusIndex(4, -1, true)).toBe(3);
    expect(nextFocusIndex(4, 99, false)).toBe(0);
  });

  it('reports nothing to focus for an empty dialog', () => {
    expect(nextFocusIndex(0, -1, false)).toBeNull();
    expect(nextFocusIndex(-3, 0, false)).toBeNull();
  });

  it('leaves Tab alone when there is nothing to cycle between', () => {
    expect(shouldTrapTab('Tab', 0)).toBe(false);
    expect(shouldTrapTab('Tab', 1)).toBe(false);
    expect(shouldTrapTab('Tab', 2)).toBe(true);
  });

  it('ignores keys other than Tab', () => {
    expect(shouldTrapTab('Enter', 5)).toBe(false);
    expect(shouldTrapTab('ArrowDown', 5)).toBe(false);
  });

  it('never lands on a control removed from the tab order', () => {
    expect(FOCUSABLE_SELECTOR).not.toContain('tabindex="-1"]:not');
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
