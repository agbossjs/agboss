/** #1318e: `@Action` runs sync and 0-arg `execute`, has no timeout unless set, and a set one fails the step. */
import { describe, expect } from "vitest";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { StepError } from "../../src/core/error-families/step-errors.js";
import {
  HangStart,
  SyncActionsApplication,
  SyncStart,
  ThrowStart,
} from "./fixtures/sync-actions.application.js";

const test = testWith(SyncActionsApplication);

describe("#1318e: @Action", () => {
  test("a sync execute that returns its value is a step like an async one", async ({ app }) => {
    const output = await app.execute(SyncStart, { text: "quiet" });

    expect(output).toMatchObject({ output: { text: "QUIET" } });
  });

  test("a sync throw fails the step as an action failure, never escapes", async ({ app }) => {
    await expect(app.execute(ThrowStart, { text: "x" })).rejects.toMatchObject({
      code: "step.action",
    });
  });

  test("a set timeout fails the hung unguarded step with StepError.ActionOutcomeUnknown, on the test clock", async ({
    app,
    clock,
  }) => {
    const pending = app.execute(HangStart, { text: "x" });
    const failed = expect(pending).rejects.toBeInstanceOf(StepError.ActionOutcomeUnknown);
    await clock.advance(seconds(6));

    await failed;
  });
});
