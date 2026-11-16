import type { Clock } from "../infrastructure/clock.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { AppDeps } from "./app-deps.js";
import { endedByRun } from "./tree-expiry.js";
import { isHandedOver } from "./handed-over.js";
import { PauseClosedError } from "./pause-closed-error.js";
import { recordedAnswer, type ResumeParts } from "./resume.js";
import { PauseResolution, type PauseRecord } from "../infrastructure/pause-record.js";

/**
 * A channel's own decision for a pause (#946): the channel that was asked again by a reassignment
 * decides at once (`ChannelOutcome.decided`). It is the channel's, never a person's: no caller is
 * checked and no request is observed (`answeredByOf` and `admit` are skipped), and `answeredBy` is the
 * channel's name for a channel's pause and a thread owner's alike — the owner only reassigned it.
 * Recorded as an answer (`Pending → Resolved`, the store's compare-and-set: of two sends that decide, a
 * crash's re-send included, one applies — a pause already closed is applied once, a no-op), logged `decided`
 * and neither counted closed nor timed as an answer (#1193: the replacement was never opened), and the tree
 * moved under its lease as the thread's owner. A hand-over, or a run that ended, after the decision is the
 * run's own outcome — told and recorded by the pass — not a failure of the send.
 */

/** What a channel decision needs: a resume's parts, and whether a run's turn ended. */
export interface ChannelDecisionParts extends ResumeParts {
  readonly endedByRun: (turnId: string) => Promise<boolean>;
}

/** Records `decision` as `channel`'s answer of `pause` and moves its tree. */
export type ChannelDecision = (
  pause: PauseRecord,
  decision: unknown,
  channel: string,
) => Promise<void>;

export const channelDecisionOf =
  (parts: ChannelDecisionParts): ChannelDecision =>
  async (pause, decision, channel) => {
    const request = { pauseId: pause.pauseId, decision };
    const answer = await recordedAnswer(
      parts,
      pause,
      request,
      channel,
      PauseResolution.Decided,
    ).catch((error: unknown) => {
      // answered, cancelled or expired meanwhile — another send's decision, or the run's own end
      if (error instanceof PauseClosedError) return undefined;
      throw error;
    });
    if (answer === undefined) return;
    const ownerId = await parts.ownerOf(pause.tenantId, pause.threadId);
    try {
      await parts.moves.resumed(answer, { ownerId });
    } catch (error) {
      const turnId = answer.run?.turnId;
      if (isHandedOver(error) || (turnId !== undefined && (await parts.endedByRun(turnId)))) return;
      throw error;
    }
  };

/** The stores, clock and deps a reassignment's sends read. */
export interface ChannelSendBase {
  readonly pauses: PausedExecutionRepository;
  readonly clock: Clock;
  readonly deps: AppDeps;
}

/** The stores, clock and deps a reassignment's sends read. */
export interface ChannelSendBase {
  readonly pauses: PausedExecutionRepository;
  readonly clock: Clock;
  readonly deps: AppDeps;
}

/** What a workflow's reassignment sends are made of, and the resume's parts they share. */
export interface ReplacementSends extends ChannelSendBase {
  readonly decide: ChannelDecision;
  readonly resumeParts: ResumeParts;
}

/** The channel's decision entry point over a workflow's resume parts, with its stores, clock and deps. */
export const replacementSendsOf = (
  resumeParts: ResumeParts,
  base: ChannelSendBase,
): ReplacementSends => ({
  ...base,
  resumeParts,
  decide: channelDecisionOf({ ...resumeParts, endedByRun: (id) => endedByRun(base, id) }),
});
