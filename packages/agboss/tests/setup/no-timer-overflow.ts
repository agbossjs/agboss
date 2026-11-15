/**
 * #1141: no Node `TimeoutOverflowWarning` is ever emitted in the suite — a timer set above 2^31 − 1
 * ms fires at once, so one warning means a duration reached a timer unchecked. Registered as a vitest
 * setup file; a test file that saw one fails after its tests.
 */
import { afterAll, expect } from "vitest";

const overflows: string[] = [];

process.on("warning", (warning) => {
  if (warning.name === "TimeoutOverflowWarning") overflows.push(warning.message);
});

afterAll(async () => {
  // Node emits a warning on the next tick: let it arrive
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(overflows).toEqual([]);
});
