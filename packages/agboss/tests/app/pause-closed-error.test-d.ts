import { describe, expectTypeOf, it } from "vitest";
import type {
  AGBossError,
  NotPausedError,
  PauseClosedError,
  PauseClosedErrorOptions,
  PauseClosedReason,
  UnknownPauseError,
} from "../../src/index.js";

/** #939: `PauseClosedError` is one error of the family — its code narrows, its options are its fields. */
describe("#939: PauseClosedError's type", () => {
  it("`switch (error.code)` narrows to it; its options are its fields", () => {
    const narrowed = (error: PauseClosedError | NotPausedError | UnknownPauseError): string => {
      switch (error.code) {
        case "pause.closed":
          expectTypeOf(error).toEqualTypeOf<PauseClosedError>();
          expectTypeOf(error.reason).toEqualTypeOf<PauseClosedReason>();
          expectTypeOf(error.closedAt).toBeString();
          return error.pauseId;
        default:
          return error.message;
      }
    };

    expectTypeOf(narrowed).returns.toBeString();
    expectTypeOf<PauseClosedError>().toExtend<AGBossError>();
    expectTypeOf<PauseClosedErrorOptions>().toExtend<
      Pick<PauseClosedError, "pauseId" | "tenantId" | "reason" | "closedAt">
    >();
  });
});
