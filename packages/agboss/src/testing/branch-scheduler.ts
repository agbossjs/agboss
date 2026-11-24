import type { AppDepsOptions } from "../app/app-deps.js";
import { schedulerOf } from "./concurrency/schedulers.js";
import type { TestConcurrency } from "./concurrency/test-concurrency.js";
import type { ScriptBook } from "./script-book.js";

/** The app option of a test's branch schedule: none for `TestConcurrency.Real`. */
export function branchSchedulerOf(
  concurrency: TestConcurrency | undefined,
  book: ScriptBook,
): Pick<AppDepsOptions, "branchScheduler"> {
  const branchScheduler = schedulerOf(concurrency, book);
  return branchScheduler === undefined ? {} : { branchScheduler };
}
