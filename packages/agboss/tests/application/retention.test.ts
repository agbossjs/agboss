/**
 * #834 — `@Application({ retention })`: one group for every kind of row the application keeps,
 * checked at assembly (`[application.retention-invalid]`) and read by the recovery sweep, which
 * removes each kind past its own retention on the `Clock`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { DEFAULT_RETENTION, type RetentionOptions } from "../../src/application/retention.js";
import {
  A2ATaskRepository,
  CostLedgerRepository,
  ExecutionHistoryRepository,
  ExecutionLeaseEventRepository,
  FencedEffectRepository,
  InMemoryFencedEffectRepository,
  MeshRequestRepository,
  OutboundCallRepository,
  PausedExecutionRepository,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes, seconds, type Milliseconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { ChargeWorkflow, resetFencedEffect } from "../app/fixtures/fenced-effect.workflow.js";
import { IdempotencyKeyEnvironment } from "../helpers/idempotency-key.environment.js";

beforeEach(() => {
  resetFencedEffect();
});

const assembledWith = (retention: unknown) => {
  @Application({
    name: "retention-application",
    version: "1.0.0",
    environment: IdempotencyKeyEnvironment,
    idempotencyKeyField: "idempotencyKey",
    workflows: [ChargeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [InMemoryFencedEffectRepository],
    // a JavaScript caller's value: what the type would refuse, the assembly refuses too
    ...(retention === undefined ? {} : { retention: retention as RetentionOptions }),
  })
  class RetentionApplication {}
  return applicationOf(RetentionApplication);
};

describe("#834 AC1: one retention group", () => {
  it("the defaults: a day, a week for outbound calls, 30 minutes for mesh answers, no execution records", async () => {
    const assembled = await assembledWith(undefined);

    expect(assembled).toMatchObject({
      pauseRecordRetention: hours(24),
      leaseEventRetention: hours(24),
      ledgerEntryRetention: hours(24),
      a2aTaskRetention: hours(24),
      meshAnswerRetention: minutes(30),
      fencedEffects: { retention: hours(24) },
      outboundCalls: { retention: hours(168) },
    });
    expect(assembled.executionRecordRetention).toBeUndefined();
    expect(DEFAULT_RETENTION).not.toHaveProperty("executionRecords");
  });
});

describe("#834 AC2: [application.retention-invalid]", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1h"])(
    "a pauseRecords of %s fails assembly",
    async (value) => {
      await expect(assembledWith({ pauseRecords: value })).rejects.toThrow(
        `[application.retention-invalid] its retention.pauseRecords is ${String(value)}, not a positive duration`,
      );
    },
  );

  it.each(["fencedEffects", "outboundCalls", "costLedgerEntries"])(
    "%s at the lease fails assembly: a mark, an intent or an entry would go before a zombie's write",
    async (field) => {
      await expect(assembledWith({ [field]: seconds(30) })).rejects.toThrow(
        `[application.retention-invalid] its retention.${field} is 30000 ms, not above the lease's 30000 ms`,
      );
    },
  );

  it("the others may be under the lease", async () => {
    const assembled = await assembledWith({ meshAnswers: seconds(5), pauseRecords: seconds(5) });

    expect(assembled).toMatchObject({
      meshAnswerRetention: seconds(5),
      pauseRecordRetention: seconds(5),
    });
  });

  it("a field it does not know is a typo, never a silent default", async () => {
    await expect(assembledWith({ ledgerEntries: hours(1) })).rejects.toThrow(
      "[application.retention-invalid] its retention.ledgerEntries is not a retention (pauseRecords, executionRecords, leaseEvents, costLedgerEntries, fencedEffects, outboundCalls, meshAnswers, a2aTasks)",
    );
  });

  it.each([null, hours(1), [hours(1)]])("a retention of %s is not an object", async (value) => {
    await expect(assembledWith(value)).rejects.toThrow(
      /\[application\.retention-invalid\] its retention is .*, not an object of retentions/,
    );
  });

  it("every problem at once, with the fix", async () => {
    const assembly = assembledWith({ leaseEvents: 0, outboundCalls: seconds(1) });

    await expect(assembly).rejects.toThrow(/retention\.leaseEvents is 0, not a positive duration/);
    await expect(assembly).rejects.toThrow(
      /retention\.outboundCalls is 1000 ms, not above the lease's 30000 ms — @Application\(\{ retention: \{/,
    );
  });
});

const RETENTION = {
  pauseRecords: minutes(2),
  executionRecords: minutes(3),
  leaseEvents: minutes(4),
  costLedgerEntries: minutes(5),
  fencedEffects: minutes(6),
  outboundCalls: minutes(7),
  meshAnswers: minutes(8),
  a2aTasks: minutes(9),
} as const satisfies RetentionOptions;

@Application({
  name: "kept-rows-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InMemoryFencedEffectRepository],
  retention: RETENTION,
})
class KeptRowsApplication {}

const kept = testWith(KeptRowsApplication);

describe("#834 AC1: the recovery sweep removes each kind past its own retention", () => {
  kept("each store is asked with now − its retention, on the Clock", async ({ app, clock }) => {
    await app.ready();
    const removals: [string, { mock: { calls: unknown[][] } }, Milliseconds][] = [
      [
        "pauseRecords",
        vi.spyOn(app.resolve(PausedExecutionRepository), "deleteResolvedBefore"),
        RETENTION.pauseRecords,
      ],
      [
        "executionRecords",
        vi.spyOn(app.resolve(ExecutionHistoryRepository), "deleteByEndedAtBefore"),
        RETENTION.executionRecords,
      ],
      [
        "leaseEvents",
        vi.spyOn(app.resolve(ExecutionLeaseEventRepository), "deleteByOccurredAtBefore"),
        RETENTION.leaseEvents,
      ],
      [
        "costLedgerEntries",
        vi.spyOn(app.resolve(CostLedgerRepository), "deleteEntriesByMadeAtBefore"),
        RETENTION.costLedgerEntries,
      ],
      [
        "fencedEffects",
        vi.spyOn(app.resolve(FencedEffectRepository), "deleteByStoredAtBefore"),
        RETENTION.fencedEffects,
      ],
      [
        "outboundCalls",
        vi.spyOn(app.resolve(OutboundCallRepository), "deleteByEndedAtBefore"),
        RETENTION.outboundCalls,
      ],
      [
        "meshAnswers",
        vi.spyOn(app.resolve(MeshRequestRepository), "deleteCreatedBefore"),
        RETENTION.meshAnswers,
      ],
      [
        "a2aTasks",
        vi.spyOn(app.resolve(A2ATaskRepository), "deleteTerminalByStatusAtBefore"),
        RETENTION.a2aTasks,
      ],
    ];

    await clock.advance(seconds(31));
    const now = clock.now().getTime();

    for (const [field, removal, retention] of removals) {
      expect({ field, calls: removal.mock.calls }).toEqual({
        field,
        calls: expect.arrayContaining([[new Date(now - retention)]]) as unknown,
      });
    }
  });
});
