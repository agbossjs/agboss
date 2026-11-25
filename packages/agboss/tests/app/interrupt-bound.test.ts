import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  BoundAgent,
  BoundApplication,
  BoundStart,
  boundSeen,
  Hang,
} from "./fixtures/interrupt-bound.workflow.js";

const test = testWith(BoundApplication);

beforeEach(() => {
  boundSeen.cleanups.length = 0;
  boundSeen.errors.length = 0;
  delete boundSeen.started;
});

/** #1341b: the cleanups of an interrupted step are bounded by `shutdownTimeout`; past it the step goes on. */
describe("#1341b: onInterrupted is bounded by executionLimits.shutdownTimeout", () => {
  test("a cleanup that never returns ends the wait at the bound: the rest is not run, the failure is reported, the call resolves", async ({
    app,
    mockModel,
    clock,
  }) => {
    mockModel(BoundAgent).thenReturn(callTool(Hang, { text: "a" }));
    const started = new Promise<string>((resolve) => {
      boundSeen.started = resolve;
    });
    const run = execute(app, BoundStart, { text: "go" });
    const threadId = await started;

    await app.stop(threadId, { mode: InterruptMode.Immediate });
    // the newest cleanup began and hangs; nothing ended the step yet
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(boundSeen.cleanups).toEqual(["newest:begun"]);
    await clock.advance(seconds(6));
    const output = await run;

    expect(output.status).toBe(ExecutionStatus.Stopped);
    expect(boundSeen.cleanups).toEqual(["newest:begun"]);
    expect(boundSeen.errors).toEqual([
      "stopped:the onInterrupted cleanups did not finish within shutdownTimeout",
    ]);
  });
});
