/**
 * #500 — `@Application({ fencedEffects })`: the largest result and the retention, checked at
 * assembly (`[application.fenced-effects-invalid]`), read by the fenced-effect store (a result above
 * `maxResultSize` fails the step and rolls back — an ordinary failure, `.onError` takes it) and by
 * the recovery sweep, which removes results and marks past the retention on the `Clock`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import {
  EmptyEnvironment,
  FencedEffectRepository,
  FencedEffectSettings,
  InMemoryFencedEffectRepository,
  type FencedEffectsOptions,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, kilobytes, minutes, seconds, type Bytes } from "../../src/units/index.js";
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

const assembledWith = (fencedEffects: FencedEffectsOptions) => {
  @Application({
    name: "settings-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ChargeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [InMemoryFencedEffectRepository],
    fencedEffects,
  })
  class SettingsApplication {}
  return applicationOf(SettingsApplication);
};

describe("#500: @Application({ fencedEffects }) at assembly", () => {
  it("defaults to 64 KB and a day", async () => {
    const assembled = await assembledWith({});

    expect(assembled.fencedEffects).toEqual(new FencedEffectSettings());
    expect(assembled.fencedEffects).toMatchObject({ maxResultSize: 65_536, retention: hours(24) });
  });

  it.each([0, -1])("a maxResultSize of %s bytes fails assembly", async (size) => {
    await expect(assembledWith({ maxResultSize: size as Bytes })).rejects.toThrow(
      `[application.fenced-effects-invalid] its fencedEffects.maxResultSize is ${String(size)} bytes, not a positive size`,
    );
  });

  it("a retention not above the lease's 30 s fails assembly, with the size's problem too", async () => {
    const assembly = assembledWith({ maxResultSize: kilobytes(0), retention: seconds(30) });

    await expect(assembly).rejects.toThrow(/retention is 30000 ms, not above the lease's 30000 ms/);
    await expect(assembly).rejects.toThrow(/maxResultSize is 0 bytes/);
  });

  it("takes what it sets", async () => {
    const assembled = await assembledWith({ maxResultSize: kilobytes(1), retention: seconds(31) });

    expect(assembled.fencedEffects).toMatchObject({ maxResultSize: 1024, retention: seconds(31) });
  });
});

@Application({
  name: "small-fenced-effect-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  providers: [InMemoryFencedEffectRepository, RecordingLogger],
  fencedEffects: { maxResultSize: kilobytes(1), retention: minutes(1) },
})
class SmallFencedEffectApplication {}

const small = testWith(SmallFencedEffectApplication);

describe("#500: the store and the sweep read the settings", () => {
  small(
    "a result above maxResultSize fails the step and rolls back: the side path takes it, nothing charged",
    async ({ app }) => {
      charging.padding = 2000;

      const result = await execute(app, ChargeWorkflowStart, { text: "order-1" });

      expect(result.finish).toMatchObject({ name: "not-charged-workflow-finish" });
      expect(JSON.stringify(result.handledErrors)).toMatch(
        /FencedEffectResultTooLargeError|fenced-effect.result-too-large/,
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
