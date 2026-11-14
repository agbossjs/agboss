import type { FaultScenario, RunnableFaultScenario } from "../scenario.js";
import { SABOTAGES } from "./sabotages.js";
import { s01Drains, s01TakenOver } from "./s01-sigterm.js";
import { s02Kill } from "./s02-kill.js";
import { s03FencedEffect, s03Payment } from "./s03-crash-after-effect.js";
import { s04LeaseExpiry } from "./s04-lease-expiry.js";
import {
  s05ZombieAfter,
  s05ZombieAfterBounded,
  s05ZombieFirst,
  s05ZombieFirstBounded,
  s05ZombiePaysFirst,
  s05ZombiePaysFirstBounded,
} from "./s05-zombie.js";
import {
  s05ZombieRecordedNotSent,
  s05ZombieRecordedNotSentBounded,
} from "./s05d-recorded-not-sent.js";
import { s06FinishedChild, s06ScaleDown } from "./s06-children.js";
import { s07NewPod } from "./s07-new-pod.js";
import { s08Back, s08Cut } from "./s08-database-loss.js";
import { s09CrashAfterSend, s10OneOrderTwoTrees } from "./s09-s10-gateway.js";
import { s11InGrace, s11Misconfigured } from "./s11-short-grace.js";
import { s12RealFailure } from "./s12-real-failure.js";
import { s12bMarkedUndo } from "./s12b-marked-undo.js";
import { s13ClockAhead, s13ClockBehind } from "./s13-clock-skew.js";
import { s14AmbiguousAnswer, s15KeyExpired } from "./s14-s15-key-expiry.js";
import { s16ClaimAnswerLost } from "./s16-claim-answer-lost.js";
import { s17AcceptCrash, s17bIdKeptCrash } from "./s17-a2a-accept-crash.js";
import {
  s17AcceptCrashBounded,
  s17bIdKeptCrashBounded,
  s17cClaimNeverAnswers,
  s17dAcceptNeverAnswers,
} from "./s17-bounded.js";
import {
  s18bCancelFirst,
  s18cResumedNotRun,
  s18dDrainTookAnswer,
  s18ResumeFirst,
} from "./s18-a2a-resume-vs-cancel.js";
import { s19Paused, s19bAnswering, s19cResuming } from "./s19-pause.js";

import { s20bCancelAtPayment, s20CancelAtCharge } from "./s20-cancel-at-payment.js";
import { s21bDelivered, s21cCommitted, s21Claimed } from "./s21-pause-notices.js";
import {
  s22aChargeNeverAnswers,
  s22bChargeCommittedNeverAnswered,
} from "./s22-store-never-answers.js";
import {
  s22c2AnswerRecordedNeverAnswered,
  s22cPaymentAnswerNeverRecorded,
  s22d2IntentRecordedNeverAnswered,
  s22dIntentNeverAnswered,
  s22eFailureNeverRecorded,
} from "./s22-outbound-never-answers.js";
import { s22fChildClaimNeverAnswered, s22gDatabaseFrozen } from "./s22-child-database.js";
import { s23CommitAnswerReset } from "./s23-commit-answer-reset.js";
import { s24BeforeRecord, s24bAfterRecord, s24cZombie, s24eOnce } from "./s24-pause-expiry.js";
import { s24dCancel } from "./s24d-pause-expiry-cancel.js";

/** Every fault scenario, in the suite's order (#484). */
export const SCENARIOS: readonly RunnableFaultScenario[] = [
  s01Drains,
  s01TakenOver,
  s02Kill,
  s03FencedEffect,
  s03Payment,
  s04LeaseExpiry,
  s05ZombieAfter,
  s05ZombieFirst,
  s05ZombiePaysFirst,
  s05ZombieRecordedNotSent,
  s05ZombieAfterBounded,
  s05ZombieFirstBounded,
  s05ZombiePaysFirstBounded,
  s05ZombieRecordedNotSentBounded,
  s06ScaleDown,
  s06FinishedChild,
  s07NewPod,
  s08Cut,
  s08Back,
  s09CrashAfterSend,
  s10OneOrderTwoTrees,
  s11InGrace,
  s11Misconfigured,
  s12RealFailure,
  s12bMarkedUndo,
  s13ClockAhead,
  s13ClockBehind,
  s14AmbiguousAnswer,
  s15KeyExpired,
  s16ClaimAnswerLost,
  s17AcceptCrash,
  s17bIdKeptCrash,
  s17AcceptCrashBounded,
  s17bIdKeptCrashBounded,
  s17cClaimNeverAnswers,
  s17dAcceptNeverAnswers,
  s18ResumeFirst,
  s18bCancelFirst,
  s18cResumedNotRun,
  s18dDrainTookAnswer,
  s19Paused,
  s19bAnswering,
  s19cResuming,
  s20CancelAtCharge,
  s20bCancelAtPayment,
  s21Claimed,
  s21bDelivered,
  s21cCommitted,
  s22aChargeNeverAnswers,
  s22bChargeCommittedNeverAnswered,
  s22cPaymentAnswerNeverRecorded,
  s22c2AnswerRecordedNeverAnswered,
  s22dIntentNeverAnswered,
  s22d2IntentRecordedNeverAnswered,
  s22eFailureNeverRecorded,
  s22fChildClaimNeverAnswered,
  s22gDatabaseFrozen,
  s23CommitAnswerReset,
  s24BeforeRecord,
  s24bAfterRecord,
  s24cZombie,
  s24dCancel,
  s24eOnce,
];

/** A scenario's name only (#831): what the suite runs stays its own. */
const named = ({ id, title }: FaultScenario): FaultScenario => Object.freeze({ id, title });

/**
 * Every fault scenario `faultSuite` runs, in its order (#484): each one's id (what `scenarios:`
 * selects) and title.
 */
export const FAULT_SCENARIOS: readonly FaultScenario[] = Object.freeze(SCENARIOS.map(named));

/**
 * The sabotages `faultSuite` runs after them (#657, #658, #831): scenarios on the fixture's payment
 * integration broken on purpose, each passing only when it charges twice.
 */
export const FAULT_SABOTAGE_SCENARIOS: readonly FaultScenario[] = Object.freeze(
  SABOTAGES.map(named),
);
