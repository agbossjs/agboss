import { redactedFilesIn } from "../a2a/files/a2a-file-scrub.js";

/**
 * The instance's tally of a lost pass's Unknown-cost entries (#875): its metrics' counters, given
 * to the observer manager when the app has a meter provider — read by the runtime, never by a
 * project's observer.
 */
export interface UnknownCostTally {
  /** A pass recorded `count` Unknown-cost entries for a step of `workflow`, before running it again. */
  recorded(workflow: string, count: number): void;
  /** A pass of `workflow` could not read its tree's lost passes: their entries are not recorded. */
  unrecorded(workflow: string): void;
}

/** What an event goes through before any observer sees it (the PII observability mask, #120). */
export type EventMask = (event: unknown) => Promise<unknown>;

/** Without policies an event is still shown without a file's bytes (#899 §0). */
export const unmasked: EventMask = (event) => Promise.resolve(redactedFilesIn(event));
