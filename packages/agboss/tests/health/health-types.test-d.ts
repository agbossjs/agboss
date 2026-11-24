import { describe, expectTypeOf, it } from "vitest";
import {
  HealthCheck,
  HealthCheckResult,
  JudgeVerdict,
  type FailedHealthCheckResult,
  type FailedJudgeVerdict,
  type HealthReport,
} from "../../src/index.js";

describe("#1343c types", () => {
  it("the reasons are plain strings, the report has the three flags", () => {
    expectTypeOf(HealthCheckResult.unhealthy("down")).toEqualTypeOf<FailedHealthCheckResult>();
    expectTypeOf(HealthCheckResult.degraded("slow")).toEqualTypeOf<FailedHealthCheckResult>();
    expectTypeOf(
      JudgeVerdict.failed("no", { metrics: { score: 0 } }),
    ).toEqualTypeOf<FailedJudgeVerdict>();
    expectTypeOf<HealthReport["isBusy"]>().toEqualTypeOf<boolean>();
    expectTypeOf<HealthReport["isAlive"]>().toEqualTypeOf<boolean>();
    expectTypeOf<HealthReport["isReady"]>().toEqualTypeOf<boolean>();
    expectTypeOf(HealthCheck).toBeCallableWith();

    // @ts-expect-error — the reason is the argument, not a field
    HealthCheckResult.unhealthy({ reason: "down" });
    // @ts-expect-error — the reason is the first argument, the options the second
    JudgeVerdict.failed({ reason: "no" });
  });
});
