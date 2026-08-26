/**
 * Autoplay countdown state.
 *
 * Advancing the instant an episode ends gives the person no way to stop it.
 * This models an explicit, cancellable countdown instead: playback only moves
 * on when the timer runs out or the person chooses to skip ahead, and a
 * cancellation is remembered so the countdown cannot immediately restart.
 */

export const DEFAULT_AUTOPLAY_SECONDS = 10;

export type AutoplayStatus = 'idle' | 'counting' | 'cancelled' | 'advancing';

export interface AutoplayState {
  status: AutoplayStatus;
  secondsRemaining: number;
}

export type AutoplayAction =
  | { type: 'playback-ended'; seconds?: number }
  | { type: 'tick' }
  | { type: 'cancel' }
  | { type: 'advance-now' }
  | { type: 'reset' };

export const initialAutoplayState: AutoplayState = {
  status: 'idle',
  secondsRemaining: 0
};

export function autoplayReducer(state: AutoplayState, action: AutoplayAction): AutoplayState {
  switch (action.type) {
    case 'playback-ended': {
      // A person who already cancelled should not be asked again for the same
      // item; only an explicit reset (a new item) clears that decision.
      if (state.status === 'cancelled' || state.status === 'advancing') return state;
      const seconds = Math.max(1, Math.round(action.seconds ?? DEFAULT_AUTOPLAY_SECONDS));
      return { status: 'counting', secondsRemaining: seconds };
    }

    case 'tick': {
      if (state.status !== 'counting') return state;
      const secondsRemaining = state.secondsRemaining - 1;
      return secondsRemaining <= 0
        ? { status: 'advancing', secondsRemaining: 0 }
        : { status: 'counting', secondsRemaining };
    }

    case 'cancel':
      if (state.status !== 'counting') return state;
      return { status: 'cancelled', secondsRemaining: 0 };

    case 'advance-now':
      if (state.status === 'advancing') return state;
      return { status: 'advancing', secondsRemaining: 0 };

    case 'reset':
      return initialAutoplayState;

    default:
      return state;
  }
}

/** True while the countdown card should be on screen. */
export function isCountdownVisible(state: AutoplayState): boolean {
  return state.status === 'counting';
}

/** True on the single transition where the next item should start. */
export function shouldAdvance(state: AutoplayState): boolean {
  return state.status === 'advancing';
}
