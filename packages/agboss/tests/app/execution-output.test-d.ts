import { describe, expectTypeOf, it } from "vitest";
import type {
  CancelledExecutionOutput,
  ExecutionOutput,
  FinishedExecutionOutput,
  PausedExecutionOutput,
  StoppedExecutionOutput,
} from "../../src/index.js";
import { ExecutionStatus } from "../../src/index.js";
import type { ComponentRecord } from "../../src/flow/runtime/records.js";
import type { PendingPause } from "../../src/pause/types.js";

/** #1341: an execution's outcome is a union on `status`: a cancel and a stop are outcomes, not errors. */
describe("#1341: ExecutionOutput is a union on status", () => {
  it("the four statuses are the four members", () => {
    expectTypeOf<ExecutionOutput["status"]>().toEqualTypeOf<
      | ExecutionStatus.Finished
      | ExecutionStatus.Paused
      | ExecutionStatus.Stopped
      | ExecutionStatus.Cancelled
    >();
    expectTypeOf<ExecutionOutput>().toEqualTypeOf<
      | FinishedExecutionOutput
      | PausedExecutionOutput
      | StoppedExecutionOutput
      | CancelledExecutionOutput
    >();
  });

  it("narrowing on status gives `finish` and `output` only to Finished, `pending` to Paused", () => {
    const narrowed = (result: ExecutionOutput<{ id: string }>): string => {
      switch (result.status) {
        case ExecutionStatus.Finished:
          expectTypeOf(result.output).toEqualTypeOf<{ id: string }>();
          expectTypeOf(result.finish).toEqualTypeOf<ComponentRecord>();
          expectTypeOf(result.pending).toEqualTypeOf<readonly []>();
          return result.output.id;
        case ExecutionStatus.Paused:
          expectTypeOf(result.pending).toEqualTypeOf<readonly PendingPause[]>();
          expectTypeOf(result.output).toEqualTypeOf<undefined>();
          return "paused";
        case ExecutionStatus.Stopped:
        case ExecutionStatus.Cancelled:
          expectTypeOf(result.reason).toEqualTypeOf<string | undefined>();
          expectTypeOf(result.pending).toEqualTypeOf<readonly []>();
          expectTypeOf(result.finish).toEqualTypeOf<undefined>();
          return result.status;
      }
    };

    expectTypeOf(narrowed).returns.toBeString();
  });

  it("before narrowing, `output` and `finish` read through optional chaining", () => {
    const early = (result: ExecutionOutput<{ id: string }>) => result.output?.id;

    expectTypeOf(early).returns.toEqualTypeOf<string | undefined>();
  });

  it("a cancel and a stop carry the base of every outcome", () => {
    expectTypeOf<CancelledExecutionOutput>().toHaveProperty("compensations");
    expectTypeOf<StoppedExecutionOutput>().toHaveProperty("spend");
    expectTypeOf<CancelledExecutionOutput["status"]>().toEqualTypeOf<ExecutionStatus.Cancelled>();
    expectTypeOf<StoppedExecutionOutput["status"]>().toEqualTypeOf<ExecutionStatus.Stopped>();
  });
});
