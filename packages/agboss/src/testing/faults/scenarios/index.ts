import type { FaultScenario } from "../scenario.js";
import { s01Drains, s01TakenOver } from "./s01-sigterm.js";
import { s02Kill } from "./s02-kill.js";
import { s03FencedEffect, s03Payment } from "./s03-crash-after-effect.js";
import { s04LeaseExpiry } from "./s04-lease-expiry.js";
import { s05ZombieAfter, s05ZombieFirst, s05ZombiePaysFirst } from "./s05-zombie.js";
import { s05ZombieRecordedNotSent } from "./s05d-recorded-not-sent.js";
import { s06FinishedChild, s06ScaleDown } from "./s06-children.js";
import { s07NewPod } from "./s07-new-pod.js";
import { s08Back, s08Cut } from "./s08-database-loss.js";
import { s09CrashAfterSend, s10OneOrderTwoTrees } from "./s09-s10-gateway.js";
import { s11InGrace, s11Misconfigured } from "./s11-short-grace.js";
import { s12RealFailure } from "./s12-real-failure.js";
import { s12bMarkedUndo } from "./s12b-marked-undo.js";
import { s13ClockAhead, s13ClockBehind } from "./s13-clock-skew.js";

/** Every fault scenario, in the suite's order (#484). */
export const FAULT_SCENARIOS: readonly FaultScenario[] = [
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
];
