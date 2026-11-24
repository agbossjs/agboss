import type { PauseRecord } from "../infrastructure/pause-record.js";

/**
 * Where a pause's applied changes are counted (#943): the instance that applied a change tells its
 * tally, once, after the store returned the changed record — so a change another instance won, or a
 * re-entry that changed nothing, counts nowhere. Implementations never throw and never read an id,
 * a tenant or a question: only the workflow, the channel's name and the close's reason.
 */
export interface PauseTally {
  /** The pause's channel was asked (`markSent`); a re-entry of a sent pause is not told. */
  opened(pause: PauseRecord): void;
  /** `pause` is the record a close returned: answered, expired, cancelled, withdrawn, tree ended. */
  closed(pause: PauseRecord): void;
  /** `pause` is the record a deadline change (an extension) returned. */
  timeoutChanged(pause: PauseRecord): void;
  /** `pause` is the replacement a reassignment made: the open pause moved to another assignee. */
  reassigned(pause: PauseRecord): void;
  /** `pause` is the record `closeUntaken` returned: an answer no step took. */
  answerNotTaken(pause: PauseRecord): void;
}

/** The tally of a seam, when the application counts (a meter provider was given). */
export const pauseTallyOf = (
  seam: { readonly notices?: { readonly tally?: PauseTally | undefined } | undefined } | undefined,
): PauseTally | undefined => seam?.notices?.tally;
