import type { NodeEvent } from "./execution-event.js";

/**
 * A per-item launch got a longer list than its `takeFirst` (#273, #1280, `onLaunchItemsTruncated`): it
 * launched the first `takeFirst` items in the list's order and dropped the rest — never an error.
 * Plain data, no item values; `step` is the launching step.
 */
export interface LaunchItemsTruncatedEvent extends NodeEvent {
  /** `${executionId}:${nodeId}:${visitNumber}` of the launching step (`result.launches`). */
  readonly launch: string;
  /** How many items the list had. */
  readonly items: number;
  /** How many were launched: the launch's `takeFirst` (or its `maxItems`). */
  readonly takeFirst: number;
}
