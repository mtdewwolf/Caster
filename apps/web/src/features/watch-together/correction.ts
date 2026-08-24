export type DriftCorrection =
  | { kind: 'none'; playbackRate: 1 }
  | { kind: 'rate'; playbackRate: 0.95 | 1.05 }
  | { kind: 'seek'; positionSeconds: number; playbackRate: 1 }
  | { kind: 'hard-sync'; positionSeconds: number; paused: boolean; playbackRate: 1 };

export interface DriftCorrectionInput {
  localPositionSeconds: number;
  localPaused: boolean;
  targetPositionSeconds: number;
  targetPaused: boolean;
}

/** Pure bounded-drift policy shared by snapshots and periodic timeline sync. */
export function decideDriftCorrection(input: DriftCorrectionInput): DriftCorrection {
  const values = [input.localPositionSeconds, input.targetPositionSeconds];
  if (values.some((value) => !Number.isFinite(value))) {
    return { kind: 'none', playbackRate: 1 };
  }
  const target = Math.max(0, input.targetPositionSeconds);
  if (input.targetPaused || input.localPaused !== input.targetPaused) {
    return {
      kind: 'hard-sync',
      positionSeconds: target,
      paused: input.targetPaused,
      playbackRate: 1
    };
  }

  const drift = target - input.localPositionSeconds;
  const magnitude = Math.abs(drift);
  if (magnitude <= 0.25) return { kind: 'none', playbackRate: 1 };
  if (magnitude <= 2) {
    return { kind: 'rate', playbackRate: drift > 0 ? 1.05 : 0.95 };
  }
  return { kind: 'seek', positionSeconds: target, playbackRate: 1 };
}
