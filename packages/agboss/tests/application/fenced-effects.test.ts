/**
 * #500, #1317 — the largest result of a call (`maxResultSize` of its key: a result above it fails
 * the step and rolls back — an ordinary failure, `.onError` takes it); the recovery sweep removes
 * the results and marks whose `expires_at` has come, on the `Clock`.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { FencedEffectRepository, InMemoryFencedEffectRepository } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { kilobytes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { RecoveryLog, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  book,
  charging,
  ChargeWorkflow,
  ChargeWorkflowStart,
  resetFencedEffect,
} from "../app/fixtures/fenced-effect.workflow.js";

beforeEach(() => {
  resetLogged();
  resetFencedEffect();
  resetRecovery();
});

@Application({
  name: "small-fenced-effect-application",
  version: "1.0.0",
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  providers: [InMemoryFencedEffectRepository, RecordingLogger],
})
class SmallFencedEffectApplication {}

const small = testWith(SmallFencedEffectApplication);

describe("#500: the store and the sweep", () => {
  small(
    "a result above maxResultSize fails the step and rolls back: the side path takes it, nothing charged",
    async ({ app }) => {
      charging.padding = 2000;
      charging.maxResultSize = kilobytes(1);

      const result = await execute(app, ChargeWorkflowStart, { text: "order-1" });

      expect(result.finish).toMatchObject({ name: "not-charged-workflow-finish" });
      expect(JSON.stringify(result.handledErrors)).toMatch(
        /IdempotencyError.ResultTooLarge|fenced-effect.result-too-large/,
      );
      expect(book.charges).toEqual([]);
    },
  );

  small("the recovery sweep removes what has expired, on the Clock", async ({ app, clock }) => {
    await app.ready();
    const effects = app.resolve(FencedEffectRepository);
    const removal = vi.spyOn(effects, "deleteExpired");
    await execute(app, ChargeWorkflowStart, { text: "order-1" });

    await clock.advance(seconds(31));

    expect(removal).toHaveBeenCalledWith(clock.now());
  });

  small(
    "a store that fails to remove is logged as recovery.failed, and asked again at the next sweep",
    async ({ app, clock }) => {
      await app.ready();
      const effects = app.resolve(FencedEffectRepository);
      const removal = vi.spyOn(effects, "deleteExpired").mockRejectedValue(new Error("disk full"));

      await clock.advance(seconds(31));
      await clock.advance(seconds(31));

      expect(logged).toContainEqual(
        expect.objectContaining({
          code: "recovery.failed",
          message: "the idempotent effects' expired results could not be removed: Error: disk full",
        }),
      );
      expect(removal.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );
});
