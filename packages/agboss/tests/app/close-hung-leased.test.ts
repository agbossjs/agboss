/**
 * #928 AC1 — `app.close()` ends within its shutdown timeout while a step's fenced write is held for
 * ever: the bound hands the tree over (or the stop's own end gives it up), nothing waits for the
 * silent store.
 */
import { afterEach, describe, expect } from "vitest";
import { testWith } from "../../src/testing/index.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { ChargeWorkflowStart } from "./fixtures/fenced-effect.workflow.js";
import { StoreBoundApplication } from "./fixtures/store-bound.application.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";

const test = testWith(StoreBoundApplication);

afterEach(() => {
  processHoldPoints.releaseAll();
});

describe("#928 AC1: close() within its timeout with a fenced write held for ever", () => {
  test("the stop does not wait for a write the store never answers", async ({ app, clock }) => {
    processHoldPoints.arm({ point: StoreHoldPoint.FencedEffectWrite });
    const failure = rejectionOf(execute(app, ChargeWorkflowStart, { text: "order-5" }));
    await until(() => processHoldPoints.held.length === 1, "the write is held");

    const closed = app.close();
    await passLive(clock, seconds(60));
    await closed;

    expect(await failure).toBeInstanceOf(Error);
  });
});
