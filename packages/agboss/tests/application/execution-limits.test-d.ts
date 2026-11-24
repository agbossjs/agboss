/** #1318c: the instance's limits are `@Application({ executionLimits })`, the flat options are gone. */
import { describe, expectTypeOf, it } from "vitest";
import type {
  ApplicationExecutionLimits,
  ApplicationOptions,
} from "../../src/application/application.js";
import type { Milliseconds } from "../../src/units/index.js";

describe("#1318c: @Application executionLimits", () => {
  it("holds the four limits of the instance", () => {
    expectTypeOf<ApplicationExecutionLimits>().toEqualTypeOf<{
      readonly childClaimTimeout?: Milliseconds;
      readonly shutdownTimeout?: Milliseconds;
      readonly maxConcurrentSteps?: number;
      readonly compensationTimeout?: Milliseconds;
    }>();
    expectTypeOf<ApplicationOptions["executionLimits"]>().toEqualTypeOf<
      ApplicationExecutionLimits | undefined
    >();
  });

  it("no longer takes the flat options", () => {
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("shutdownTimeout");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("maxConcurrentSteps");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("compensationTimeout");
    expectTypeOf<ApplicationOptions>().not.toHaveProperty("childClaimTimeout");
  });
});
