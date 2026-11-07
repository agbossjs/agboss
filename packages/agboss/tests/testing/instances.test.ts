/**
 * #265 PR 1 (#262 AC13 in its first form): `testWith(App, { instances: 2 })` — two application
 * instances, each its own container, over one set of stores and one clock (the virtual clock
 * itself: clock.test.ts).
 */
import type { MeterProvider } from "@opentelemetry/api";
import { describe, expect, expectTypeOf, it } from "vitest";
import { testInstancesOf } from "../../src/testing/environment.js";
import {
  callTool,
  ClockSkew,
  testWith,
  type TestInstanceOptions,
  type TestWithOptions,
} from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { Clock } from "../../src/infrastructure/clock.js";
import { execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  LeaseApplication,
  OrderWorkflowStart,
} from "../infrastructure/fixtures/lease.workflow.js";

const test = testWith(LeaseApplication, { instances: 2 });

/** Options a JavaScript caller could pass, typed as `TestWithOptions`. */
const untypedOptions = (value: unknown): TestWithOptions => value as TestWithOptions;

describe("testWith(App, { instances: 2 })", () => {
  test("apps[0] is app; both share the stores and the clock", async ({
    app,
    apps,
    clock,
    mockLlm,
  }) => {
    // the run pauses at the charge's approval and is cancelled there: the receipt never comes
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "1 USD" }));
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

    const cancelled = await apps[1]?.cancel(paused.threadId);

    expect(apps).toHaveLength(2);
    expect(apps[0]).toBe(app);
    expect(apps[1]?.clock).toBe(clock);
    expect(cancelled).toEqual({ cancelled: true });
  });

  testWith(LeaseApplication, { instances: 0 }).fails(
    "instances must be a whole number ≥ 1",
    async ({ apps }) => {
      expect(apps).toHaveLength(0);
      await Promise.resolve();
    },
  );
});

describe("#831 AC3: instances: [{ clockSkew, meterProvider }] — one entry per instance", () => {
  const skewed = testWith(LeaseApplication, {
    instances: [{}, { clockSkew: ClockSkew.ahead(seconds(300)) }],
  });

  skewed(
    "each instance gets its own entry's settings; a list's length is the count",
    async ({ apps, clock }) => {
      expect(apps).toHaveLength(2);
      const [first, second] = apps;
      await Promise.all(apps.map((one) => one.ready()));
      expect(first?.resolve(Clock).now().getTime()).toBe(clock.now().getTime());
      expect(second?.resolve(Clock).now().getTime()).toBe(clock.now().getTime() + 300_000);
    },
  );

  it("an empty list, a non-object, an unknown key or a clockSkew that is no ClockSkew is refused", () => {
    const refused = [
      [[], /non-empty list/u],
      [[null], /instances\[0\]: not an object/u],
      [[{}, { clockSkews: ClockSkew.none }], /instances\[1\]: clockSkews — an instance takes/u],
      [[{ clockSkew: { offset: 1, drift: 0 } }], /instances\[0\]\.clockSkew: not a ClockSkew/u],
      [0, /a whole number ≥ 1/u],
      [1.5, /a whole number ≥ 1/u],
    ] as const;
    for (const [instances, message] of refused)
      expect(() => testInstancesOf(untypedOptions({ instances }))).toThrow(message);
    expect(testInstancesOf({})).toEqual([{}]);
    // the parallel arrays of before, from JavaScript or a built options object: refused, never ignored
    for (const removed of ["clockSkews", "meterProviders"])
      expect(() => testInstancesOf(untypedOptions({ instances: 2, [removed]: [] }))).toThrow(
        new RegExp(`^${removed}: no such option`, "u"),
      );
    expect(testInstancesOf({ instances: 3 })).toEqual([{}, {}, {}]);
  });

  it("the parallel arrays of before do not compile", () => {
    expect(testInstancesOf({ instances: [{}, {}] })).toHaveLength(2);
    expectTypeOf<TestWithOptions>().not.toHaveProperty("clockSkews");
    expectTypeOf<TestWithOptions>().not.toHaveProperty("meterProviders");
    expectTypeOf<TestInstanceOptions>().toEqualTypeOf<{
      readonly clockSkew?: ClockSkew;
      readonly meterProvider?: MeterProvider;
    }>();
  });
});
