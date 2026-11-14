import type { BudgetCheck } from "../../budgets/budget-check.js";
import { DeadlineExceededError } from "../../budgets/execution-deadline.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { PauseExpiryBound, type PauseRecord } from "../../infrastructure/pause-record.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { currentFrame } from "../context/frame.js";
import { ExpiryHandlerError, PauseExpiredError } from "./pause-expired-error.js";
import { ComponentKind } from "./records.js";

/**
 * How a step that finds its pause expired fails (#941, D6, D8): the pause step throws the internal
 * `PauseExpirySignal`, the site that asked — a question step, an agent's approval or question call —
 * turns it into the step's failure: `PauseExpiredError`, or `DeadlineExceededError` when the run's
 * deadline bound the pause (D8: the run's deadline has the final word).
 */

/** A pause the step asked has expired: internal, never reaches a caller. */
export class PauseExpirySignal extends Error {
  override name = "PauseExpirySignal";

  constructor(readonly pause: PauseRecord) {
    super("a pause expired");
  }
}

/** Where the failing step is: its name, its spend and where its execution is. */
export interface ExpirySite {
  readonly step: string;
  readonly stepKind: ComponentKind.Agent | ComponentKind.Question;
  /** The execution's spend so far (its state's records). */
  readonly state: readonly UsageRecord[];
  /** The failed step's own spend: an agent's loop; none for a question. */
  readonly usage: readonly UsageRecord[];
  /** The step's path in the execution, as the budgets report it. */
  readonly path: readonly string[];
  readonly budgets: Pick<BudgetCheck, "check">;
}

/** The pause's expiry problem as the error it fell back with, from its record (no handler error is kept). */
const causeOf = (pause: PauseRecord): ExpiryHandlerError | undefined =>
  pause.expiryProblem === undefined
    ? undefined
    : new ExpiryHandlerError({ channel: pause.channel, problem: pause.expiryProblem });

/** How long the run's deadline was given: its frame's, else what the pause waited (asked → deadline). */
function givenDeadline(pause: PauseRecord, expiresAt: string): Milliseconds {
  const given = currentFrame()?.execution.deadline?.deadline;
  return given ?? seconds(Math.max(0, Date.parse(expiresAt) - Date.parse(pause.askedAt)) / 1000);
}

/** The failure of a step whose pause expired. */
export function expiryFailureOf(pause: PauseRecord, site: ExpirySite): Error {
  const expiresAt = pause.expiresAt ?? pause.askedAt;
  if (pause.expiryBound === PauseExpiryBound.RunDeadline) {
    // the run's own check first (its clock may be ahead of the pass's), else the pause's deadline
    try {
      site.budgets.check(site.state, site.path, site.usage);
    } catch (error) {
      if (error instanceof DeadlineExceededError) return error;
      throw error;
    }
    return new DeadlineExceededError({
      deadline: givenDeadline(pause, expiresAt),
      deadlineAt: expiresAt,
      path: site.path,
      spentUsd: totalCost([...site.state, ...site.usage]),
      usage: site.usage,
    });
  }
  return new PauseExpiredError({
    step: site.step,
    stepKind: site.stepKind,
    channel: pause.channel,
    kind: pause.kind,
    expiresAt,
    usage: site.usage,
    cause: causeOf(pause),
  });
}
