/** #1318c: what `@Application({ executionLimits })` leaves of the instance's limits. */
import { describe, expect, it } from "vitest";
import { limitFieldsOf } from "../../src/application/limit-fields.js";
import type { ApplicationOptions } from "../../src/application/application.js";
import { seconds } from "../../src/units/index.js";

const options = (rest: Partial<ApplicationOptions>) => rest as ApplicationOptions;

describe("limitFieldsOf", () => {
  it("defaults: a stop waits 25 s, an undo 15 s, steps are not capped", () => {
    expect(limitFieldsOf(options({}))).toEqual({
      shutdownTimeout: seconds(25),
      compensationTimeout: seconds(15),
    });
  });

  it("takes each limit from executionLimits, a cap only when set", () => {
    expect(
      limitFieldsOf(
        options({
          executionLimits: {
            shutdownTimeout: seconds(5),
            compensationTimeout: seconds(2),
            maxConcurrentSteps: 3,
          },
        }),
      ),
    ).toEqual({
      shutdownTimeout: seconds(5),
      compensationTimeout: seconds(2),
      maxConcurrentSteps: 3,
    });
  });
});
