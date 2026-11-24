import { TestSetupError } from "./errors.js";

/** The test clock's first moment: `startAt` as a date, else the default (#1328). */
export function startOf(startAt: Date | string | undefined): Date | undefined {
  if (startAt === undefined) return undefined;
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  if (Number.isNaN(start.getTime())) {
    throw new TestSetupError({
      message: `startAt: ${String(startAt)} is not a date — give a Date or an ISO 8601 text`,
    });
  }
  return start;
}
