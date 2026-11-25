/**
 * #1325a: `.onError(Family)`, `.onError(Family.Variant)` and a project's own error class route a failure
 * of the family — the nearest class in the error's line wins — and a hand-over (`LeaseLost`, `Fenced`,
 * `CancelFenced`) reaches no `.onError`, not even `.onError(ExecutionError)`. A project's error class
 * without a `static code` is caught by its own name, never by every `AGBossError` (it inherits no code).
 * DSL review (8): an action's failure stays wrapped (`StepError.Action` with the original as `cause`);
 * `.onError` matches the original's class first, and another project class falls to the wrapper.
 */
import { describe, expect } from "vitest";
import { testWith } from "../../src/testing/index.js";
import { errorRecordOf } from "../../src/core/error-record.js";
import { isHandOverRecord } from "../../src/core/error-families/run-errors.js";
import {
  ApplicationStoppingError,
  ExecutionCancelFencedError,
  ExecutionError,
  ExecutionLeaseLostError,
} from "../../src/index.js";
import { isHandedOver } from "../../src/app/handed-over.js";
import { execute } from "../helpers/flow.js";
import {
  ExecutionCaughtFinish,
  FamilyOkFinish,
  NarrowOwnCaughtFinish,
  NarrowRouteStart,
  FamilyRouteApplication,
  FamilyRouteStart,
  LimitCaughtFinish,
  OwnCaughtFinish,
  VariantCaughtFinish,
} from "./family-routing.fixtures.js";

const test = testWith(FamilyRouteApplication);
const run = async (app: Parameters<typeof execute>[0], fail: string) =>
  execute(app, FamilyRouteStart, { fail });
const runNarrow = async (app: Parameters<typeof execute>[0], fail: string) =>
  execute(app, NarrowRouteStart, { fail });

describe("#1325a: a family's errors take the side path of the nearest class", () => {
  test("nothing thrown: the main path", async ({ app }) => {
    expect(await run(app, "none")).toFinishWith(FamilyOkFinish);
  });

  test("a variant takes the handler on the variant", async ({ app }) => {
    expect(await run(app, "step-action")).toFinishWith(VariantCaughtFinish);
  });

  test("a variant of another family takes the handler on its family", async ({ app }) => {
    expect(await run(app, "limit-items")).toFinishWith(LimitCaughtFinish);
    expect(await run(app, "unknown-thread")).toFinishWith(ExecutionCaughtFinish);
  });

  test("a sibling variant, with a handler on one variant of its family only, is not caught", async ({
    app,
  }) => {
    await expect(run(app, "step-agent")).rejects.toMatchObject({ name: "StepError.Agent" });
  });
});

describe("#1325a: a hand-over reaches no .onError, not even the family's", () => {
  test("LeaseLost and Fenced reject the call: no side path, no finish", async ({ app }) => {
    await expect(run(app, "lease-lost")).rejects.toBeInstanceOf(ExecutionError.LeaseLost);
    // the family's refusal itself, never rebuilt as the legacy ExecutionError.Fenced around it
    const fenced: unknown = await run(app, "fenced").catch((error: unknown) => error);
    expect(fenced).toBeInstanceOf(ExecutionError.Fenced);
  });

  test("the kinds that are a hand-over, and only they, are handed over", () => {
    const handedOver = [
      new ExecutionError.LeaseLost({ rootExecutionId: "r" }),
      new ExecutionError.CancelFenced(),
      new ExecutionError.ApplicationStopping(),
      new ExecutionError.Fenced({
        scopeKey: "t:r",
        token: 1,
        tenantId: "t",
        leaseExecutionId: "r",
      }),
    ];

    for (const error of handedOver) expect(isHandedOver(error), error.name).toBe(true);
    expect(isHandedOver(new ExecutionError.UnknownThread())).toBe(false);
    expect(isHandedOver(new ExecutionLeaseLostError({ rootExecutionId: "r" }))).toBe(true);
  });
});

describe("#1325a: the legacy hand-overs and the family's are guarded alike while both coexist", () => {
  const legacy = [
    new ExecutionLeaseLostError({ rootExecutionId: "r" }),
    new ExecutionError.Fenced({
      scopeKey: "t:r",
      token: 1,
      tenantId: "t",
      leaseExecutionId: "r",
    }),
    new ExecutionCancelFencedError({
      scopeKey: "t:r",
      tenantId: "t",
      rootExecutionId: "r",
      leaseExecutionId: "r",
      token: 1,
      effect: "charge",
    }),
  ];

  test("the record of each legacy hand-over, and of each family one, is a hand-over record", () => {
    for (const error of legacy)
      expect(isHandOverRecord(errorRecordOf(error)), error.name).toBe(true);
    const family = [
      new ExecutionError.LeaseLost({ rootExecutionId: "r" }),
      new ExecutionError.CancelFenced(),
    ];
    for (const error of family)
      expect(isHandOverRecord(errorRecordOf(error)), error.name).toBe(true);
    expect(isHandOverRecord(errorRecordOf(new ExecutionError.UnknownThread()))).toBe(false);
  });

  test("the legacy lease-lost, fenced and stopping errors are handed over (a cancel-fenced one is read by `cancelFencedErrorOf`)", () => {
    for (const error of [...legacy.slice(0, 2), new ApplicationStoppingError({ message: "m" })])
      expect(isHandedOver(error), error.name).toBe(true);
  });
});

describe("#1325a: a project's error class is caught by its own name", () => {
  test("the class with a handler takes it", async ({ app }) => {
    expect(await run(app, "one-payment")).toFinishWith(OwnCaughtFinish);
  });

  test("the class's handler wins over the step's StepError.Action handler", async ({ app }) => {
    expect(await runNarrow(app, "one-payment")).toFinishWith(NarrowOwnCaughtFinish);
  });

  test("another project class with no code of its own is not taken by that handler: the action's failure is", async ({
    app,
  }) => {
    expect(await run(app, "other-payment")).toFinishWith(VariantCaughtFinish);
  });

  test("with no StepError.Action handler it rejects as the action's failure, the original its cause", async ({
    app,
  }) => {
    const failure: unknown = await runNarrow(app, "other-payment").catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "ActionFailedError",
      code: "step.action",
      cause: { name: "OtherPaymentError" },
    });
  });
});
