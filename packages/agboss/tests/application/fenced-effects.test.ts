/**
 * #500 — the fenced effects' retention (`@Application({ retention: { fencedEffects } })`), checked at
 * assembly, and the largest result of a call (`maxResultSize` of its key: a result above it fails
 * the step and rolls back — an ordinary failure, `.onError` takes it); the recovery sweep removes
 * results and marks past the retention on the `Clock`.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import type { RetentionOptions } from "../../src/application/retention.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { FencedEffectRepository, InMemoryFencedEffectRepository } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, kilobytes, minutes, seconds } from "../../src/units/index.js";
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
import { IdempotencyKeyEnvironment } from "../helpers/idempotency-key.environment.js";

beforeEach(() => {
  resetLogged();
  resetFencedEffect();
  resetRecovery();
});

const assembledWith = (retention?: RetentionOptions) => {
  @Application({
    name: "settings-application",
    version: "1.0.0",
    environment: IdempotencyKeyEnvironment,
    workflows: [ChargeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [InMemoryFencedEffectRepository],
    ...(retention === undefined ? {} : { retention }),
  })
  class SettingsApplication {}
  return applicationOf(SettingsApplication);
};

describe("#500: the fenced effects' retention at assembly", () => {
  it("defaults to a day", async () => {
    const assembled = await assembledWith();

    expect(assembled.fencedEffects).toMatchObject({ retention: hours(24) });
  });

  it("#834: a retention.fencedEffects not above the lease's 30 s fails assembly", async () => {
    const assembly = assembledWith({ fencedEffects: seconds(30) });

    await expect(assembly).rejects.toThrow(
      "[application.retention-invalid] its retention.fencedEffects is 30000 ms, not above the lease's 30000 ms",
    );
  });

  it("takes what it sets", async () => {
    const assembled = await assembledWith({ fencedEffects: seconds(31) });

    expect(assembled.fencedEffects).toMatchObject({ retention: seconds(31) });
  });
});

@Application({
  name: "small-fenced-effect-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  providers: [InMemoryFencedEffectRepository, RecordingLogger],
  retention: { fencedEffects: minutes(1) },
})
class SmallFencedEffectApplication {}

const small = testWith(SmallFencedEffectApplication);

describe("#500: the store and the sweep read the settings", () => {
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

  small(
    "the recovery sweep removes what was stored longer ago than the retention, on the Clock",
    async ({ app, clock }) => {
      await app.ready();
      const effects = app.resolve(FencedEffectRepository);
      const removal = vi.spyOn(effects, "deleteByStoredAtBefore");
      await execute(app, ChargeWorkflowStart, { text: "order-1" });

      await clock.advance(seconds(31));

      expect(removal).toHaveBeenCalledWith(new Date(clock.now().getTime() - minutes(1)));
    },
  );

  small(
    "a store that fails to remove is logged as recovery.failed, and asked again at the next sweep",
    async ({ app, clock }) => {
      await app.ready();
      const effects = app.resolve(FencedEffectRepository);
      const removal = vi
        .spyOn(effects, "deleteByStoredAtBefore")
        .mockRejectedValue(new Error("disk full"));

      await clock.advance(seconds(31));
      await clock.advance(seconds(31));

      expect(logged).toContainEqual(
        expect.objectContaining({
          code: "recovery.failed",
          message: "the fenced effects' results could not be removed: Error: disk full",
        }),
      );
      expect(removal.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );
});
