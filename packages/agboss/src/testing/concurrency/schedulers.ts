import type { BranchScheduler } from "../../flow/runtime/launch/branch-schedule.js";
import type { ScriptBook } from "../script-book.js";
import { CompletionGates } from "./completion-gates.js";
import { ConcurrencyMode, TestConcurrency } from "./test-concurrency.js";

/** `TestConcurrency.Sequential`: one slot per launch — its branches run one at a time, in order. */
class OneAtATime implements BranchScheduler {
  slotsOf(): number {
    return 1;
  }

  entered(): void {
    // a branch waits for the launch's one slot in listed / item order: nothing to track
  }

  started(): void {
    // nothing to track: the slot is the order
  }

  completed(): Promise<void> {
    return Promise.resolve();
  }

  ended(): void {
    // the next branch takes the slot
  }
}

/**
 * The scheduler of a test's `concurrency` (default `Sequential`); none for `Real` — the
 * production one. `inOrder`'s gates report to the test's book and are its expectation: a listed
 * step never reached fails the test at its end.
 */
export function schedulerOf(
  concurrency: TestConcurrency = TestConcurrency.Sequential,
  book: ScriptBook,
): BranchScheduler | undefined {
  switch (concurrency.mode) {
    case ConcurrencyMode.Real:
      return undefined;
    case ConcurrencyMode.Sequential:
      return new OneAtATime();
    case ConcurrencyMode.InOrder: {
      const gates = new CompletionGates(concurrency.steps, (failure) => book.report(failure));
      book.expect(gates);
      return gates;
    }
  }
}
