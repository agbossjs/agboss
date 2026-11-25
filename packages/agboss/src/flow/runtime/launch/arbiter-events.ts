import { totalCost } from "../../../finops/usage.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { ArbiterOutcome } from "../../observers/arbiter.js";
import { reportFrameEvent } from "../../observers/execution-event.js";

/**
 * A judging between `onArbiterStart` and `onArbiterEnd` (#1283, #1343): told to the observers of the
 * branch's execution — masked by its workflow's policies — from the branch's frame. The end is told
 * for every start, also when the arbiter failed or a limit ended it: `usage` is what it spent by then.
 */

/** Who judges what. */
interface JudgingAbout {
  readonly arbiter: string;
  readonly target: string;
  readonly isCode: boolean;
}

/** What a judging ended with: its verdict, whether the launch was decided meanwhile. */
interface Judged {
  readonly isAccepted: boolean;
  readonly isAbandoned: boolean;
}

const outcomeOf = ({ isAccepted, isAbandoned }: Judged): ArbiterOutcome =>
  isAbandoned
    ? ArbiterOutcome.Abandoned
    : isAccepted
      ? ArbiterOutcome.Accepted
      : ArbiterOutcome.Rejected;

/** `judge` between the two events; `usage` is read at the end, when its spend is known. */
export async function observedJudging(
  about: JudgingAbout,
  usage: readonly UsageRecord[],
  judge: () => Promise<Judged>,
): Promise<Judged> {
  await reportFrameEvent((observer, base) => observer.onArbiterStart({ ...base, ...about }));
  const ended = (outcome: ArbiterOutcome) =>
    reportFrameEvent((observer, base) =>
      observer.onArbiterEnd({ ...base, ...about, outcome, costUsd: totalCost(usage) }),
    );
  try {
    const judged = await judge();
    await ended(outcomeOf(judged));
    return judged;
  } catch (error) {
    // a failed arbiter, a limit or a cancel ends the check with no verdict
    await ended(ArbiterOutcome.NoVerdict);
    throw error;
  }
}
