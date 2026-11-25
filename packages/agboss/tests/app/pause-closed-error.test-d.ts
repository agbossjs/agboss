import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { describe, expectTypeOf, it } from "vitest";
import type { AGBossError, NotPausedError, PauseClosedReason } from "../../src/index.js";

/** #939: `PauseError.Closed` is one error of the family — its code narrows, its options are its fields. */
describe("#939: PauseError.Closed's type", () => {
  it("`switch (error.code)` narrows to it; its options are its fields", () => {
    const narrowed = (
      error: PauseError.Closed | NotPausedError | PauseError.UnknownPause,
    ): string => {
      switch (error.code) {
        case "pause.closed":
          expectTypeOf(error).toEqualTypeOf<PauseError.Closed>();
          expectTypeOf(error.reason).toEqualTypeOf<PauseClosedReason>();
          expectTypeOf(error.closedAt).toBeString();
          return error.pauseId;
        default:
          return error.message;
      }
    };

    expectTypeOf(narrowed).returns.toBeString();
    expectTypeOf<PauseError.Closed>().toExtend<AGBossError>();
    expectTypeOf<ConstructorParameters<typeof PauseError.Closed>[0]>().toExtend<
      Pick<PauseError.Closed, "pauseId" | "tenantId" | "reason" | "closedAt">
    >();
  });
});
