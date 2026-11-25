/**
 * #1325b: an action's code that throws an error of any family but the step's own fails the step as
 * `StepError.Action` (the original its cause): `.onError(StepError, …)` takes it, the original's
 * class takes it through the cause — what the folded A2A, store and configuration errors rely on.
 */
import { describe, expect } from "vitest";
import { A2AError } from "../../../src/core/error-families/a2a-errors.js";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  FamilyCaughtFinish,
  FamilyThrowApplication,
  RemoteCatchStart,
  StepCatchStart,
  UncaughtStart,
} from "./fixtures/family-throw.workflow.js";

const family = testWith(FamilyThrowApplication);

describe("an action that throws an error of another family", () => {
  for (const throws of ["a2a", "store", "config", "plain"] as const) {
    family(
      `${throws}: fails the step as StepError.Action, taken by .onError(StepError)`,
      async ({ app }) => {
        const result = await execute(app, StepCatchStart, { id: "1", throws });

        expect(result).toFinishWith(FamilyCaughtFinish, { id: "1", throws });
      },
    );
  }

  family(
    "a remote agent's error is taken by its own class, through the wrapper's cause",
    async ({ app }) => {
      const result = await execute(app, RemoteCatchStart, { id: "3", throws: "a2a" });

      expect(result).toFinishWith(FamilyCaughtFinish, { id: "3", throws: "a2a" });
    },
  );

  family(
    "an uncaught failure is StepError.Action with the remote error as its cause",
    async ({ app }) => {
      const failure = await execute(app, UncaughtStart, { id: "2", throws: "a2a" }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(StepError.Action);
      expect((failure as StepError.Action).cause).toBeInstanceOf(A2AError.TaskFailed);
    },
  );
});
