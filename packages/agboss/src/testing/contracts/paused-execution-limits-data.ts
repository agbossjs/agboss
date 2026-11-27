import type { PauseRecord } from "../../infrastructure/pause-record.js";
import { expiringPauseOf } from "./paused-execution-data.js";

/** What the limits cases (#1307, Q-D) share: instants, a destination and a pause opened under limits. */
export const FIRST = new Date("2026-01-05T08:00:00.000Z");
export const CAP = new Date("2026-01-05T20:00:00.000Z");
export const LOOSER = new Date("2026-01-06T20:00:00.000Z");
export const TIGHTER = new Date("2026-01-05T15:00:00.000Z");
export const TO = { target: "tier-one-external-task", respondent: "delegate" as never };

export const limitedPause = (
  pauseId: string,
  stepKey = "run-1:clerk-agent:1:call-1",
): PauseRecord => ({
  ...expiringPauseOf(pauseId, stepKey, {
    maxExpiresAt: new Date(CAP.getTime()),
    escalationLimits: { maxExtensions: 4, maxReassignments: 3 },
  }),
  firstAskedAt: new Date(FIRST.getTime()),
});
