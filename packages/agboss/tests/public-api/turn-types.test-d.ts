/** #890 AC4, at compile time: `TurnStatus` is a closed set of statuses (no forgotten table). */
import { describe, expectTypeOf, it } from "vitest";
import type { TurnStatus } from "../../src/index.js";

describe("#890 AC4: TurnStatus", () => {
  it("AC4: a closed set of statuses", () => {
    expectTypeOf<TurnStatus>().toEqualTypeOf<
      "running" | "answered" | "guarded" | "failed" | "paused" | "queued" | "written"
    >();
  });
});
