import { useEffect, type RefObject } from 'react';

/**
 * Keyboard containment for modal dialogs.
 *
 * A dialog that does not hold focus lets Tab walk into the page behind it,
 * which leaves keyboard and screen-reader users operating controls they cannot
 * see. The index maths is kept separate from the DOM so it can be tested
 * directly.
 */

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * The index Tab should move to, wrapping at both ends.
 *
 * Returns null when there is nothing to focus, so the caller can leave the
 * event alone rather than trapping the person in a dialog with no controls.
 */
export function nextFocusIndex(
  count: number,
  currentIndex: number,
  shiftKey: boolean
): number | null {
  if (count <= 0) return null;

  // An unknown current element (focus outside the dialog) is pulled back to the
  // near edge: the first control on Tab, the last on Shift+Tab.
  if (currentIndex < 0 || currentIndex >= count) {
    return shiftKey ? count - 1 : 0;
  }

  return shiftKey
    ? (currentIndex - 1 + count) % count
    : (currentIndex + 1) % count;
}

/** True when Tab should be intercepted rather than left to the browser. */
export function shouldTrapTab(key: string, count: number): boolean {
  return key === 'Tab' && count > 1;
}

export interface FocusTrapOptions {
  /** Called on Escape. Omit to leave Escape to the caller. */
  onEscape?: () => void;
  /** Set false for a dialog that should not steal focus on mount. */
  autoFocus?: boolean;
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { onEscape, autoFocus = true }: FocusTrapOptions = {}
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.offsetParent !== null || element === document.activeElement);

    if (autoFocus) {
      const [first] = focusable();
      if (first) first.focus();
      else container.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation();
        onEscape();
        return;
      }

      const elements = focusable();
      if (!shouldTrapTab(event.key, elements.length)) return;

      const target = nextFocusIndex(
        elements.length,
        elements.indexOf(document.activeElement as HTMLElement),
        event.shiftKey
      );
      if (target === null) return;

      event.preventDefault();
      elements[target].focus();
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => {
      container.removeEventListener('keydown', handleKeyDown);
      // Returning focus to whatever opened the dialog keeps the person's place.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, onEscape, autoFocus]);
}
