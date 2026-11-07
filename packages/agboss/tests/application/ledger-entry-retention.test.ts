/**
 * #771 — `@Application({ ledgerEntryRetention })`: how long the ledger's entries are kept, checked
 * at assembly (`[application.ledger-entry-retention-invalid]`: above the lease's 30 s) and read by
 * the recovery sweep, which prunes the entries made before `now − retention` on the `Clock` — the
 * counters never.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { CostLedgerRepository, InMemoryFencedEffectRepository } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes, seconds, type Milliseconds } from "../../src/units/index.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { ChargeWorkflow } from "../app/fixtures/fenced-effect.workflow.js";
import { IdempotencyKeyEnvironment } from "../helpers/idempotency-key.environment.js";

beforeEach(() => {
  resetLogged();
});

const assembledWith = (costLedgerEntries?: Milliseconds) => {
  @Application({
    name: "ledger-application",
    version: "1.0.0",
    environment: IdempotencyKeyEnvironment,
    idempotencyKeyField: "idempotencyKey",
    workflows: [ChargeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [InMemoryFencedEffectRepository],
    ...(costLedgerEntries === undefined ? {} : { retention: { costLedgerEntries } }),
  })
  class LedgerApplication {}
  return applicationOf(LedgerApplication);
};

describe("#771, #834: @Application({ retention: { costLedgerEntries } }) at assembly", () => {
  it("defaults to a day", async () => {
    expect((await assembledWith()).ledgerEntryRetention).toBe(hours(24));
  });

  it("a retention at the lease fails assembly", async () => {
    await expect(assembledWith(seconds(30))).rejects.toThrow(
      "[application.retention-invalid] its retention.costLedgerEntries is 30000 ms, not above the lease's 30000 ms",
    );
  });

  it.each([0, Number.NaN])("a retention of %s fails assembly", async (retention) => {
    await expect(assembledWith(retention as Milliseconds)).rejects.toThrow(
      `[application.retention-invalid] its retention.costLedgerEntries is ${String(retention)}, not a positive duration`,
    );
  });

  it("takes what it sets", async () => {
    expect((await assembledWith(seconds(31))).ledgerEntryRetention).toBe(seconds(31));
  });
});

@Application({
  name: "short-ledger-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InMemoryFencedEffectRepository, RecordingLogger],
  retention: { costLedgerEntries: minutes(1) },
})
class ShortLedgerApplication {}

const short = testWith(ShortLedgerApplication);

describe("#771: the recovery sweep prunes the ledger's entries", () => {
  short(
    "every look prunes what was made longer ago than the retention, on the Clock",
    async ({ app, clock }) => {
      await app.ready();
      const ledger = app.resolve(CostLedgerRepository);
      const prune = vi.spyOn(ledger, "deleteEntriesByMadeAtBefore");

      await clock.advance(seconds(31));

      expect(prune).toHaveBeenCalledWith(new Date(clock.now().getTime() - minutes(1)));
    },
  );

  short(
    "a ledger that fails to prune is logged as recovery.failed, and asked again at the next look",
    async ({ app, clock }) => {
      await app.ready();
      const ledger = app.resolve(CostLedgerRepository);
      const prune = vi
        .spyOn(ledger, "deleteEntriesByMadeAtBefore")
        .mockRejectedValue(new Error("disk full"));

      await clock.advance(seconds(31));
      await clock.advance(seconds(31));

      expect(logged).toContainEqual(
        expect.objectContaining({
          code: "recovery.failed",
          message: "the ledger's old entries could not be removed: Error: disk full",
        }),
      );
      expect(prune.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );
});
