import type { Milliseconds, WorkingDuration } from "../../src/units/index.js";

/** A plain number of milliseconds as the typed duration a calendar request carries. */
export const milliseconds = (amount: number): Milliseconds => amount as Milliseconds;

/** `amount` working milliseconds, made without the helpers' own checks (a test may pass what they refuse). */
export const workMs = (amount: number): WorkingDuration => {
  const raw: unknown = Object.freeze({
    [Symbol.for("agboss.units.working-duration")]: true as const,
    unit: "ms" as const,
    amount,
  });
  return raw as WorkingDuration;
};
