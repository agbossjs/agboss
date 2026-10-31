/**
 * #505 on SQLite — `SqliteOutboundCallRepository` on one file shared by two instances: a charge
 * killed before the answer is reconciled by the instance that recovers it, never sent again; the
 * intents and their lease-log rows are on the file. The store is listed with the SQLite leases
 * (`[application.store-backend-mismatch]` otherwise, #526); the unlisted in-memory default beside them
 * fails at its first call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Provider } from "../../src/components/injection.js";
import {
  ActionFailedError,
  ExecutionLeaseEventKind,
  ExecutionLeaseLostError,
  FencedEffectStoreMismatchError,
  InMemoryOutboundCallRepository,
  OutboundCallEventOutcome,
  OutboundCallOutcomeStatus,
  OutboundCallStatus,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteOutboundCallRepository,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "../infrastructure/sqlite/fixtures/environments/app.environment.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { instance, rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  ChargeWorkflow,
  ChargeWorkflowStart,
  resetRuns,
  runs,
} from "./fixtures/outbound-call.workflow.js";
import { frozenCharges, gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";
import {
  SqliteOutboundCallApplication,
  UnlistedOutboundCallStoreApplication,
} from "../infrastructure/sqlite/fixtures/sqlite-outbound-call.application.js";

sqliteFilePerTest();
const two = testWith(SqliteOutboundCallApplication, { instances: 2 });
const TREE = { tenantId: "default", rootExecutionId: "execution-1" };

beforeEach(() => {
  resetGateway();
  resetRuns();
  resetRecovery();
});

afterEach(letChargesGo);

describe("#505 AC1 on SQLite: two instances, one file", () => {
  two(
    "AC1: killed before the answer → the other instance reconciles from the file, nothing re-sent",
    async ({ apps, clock, leases }) => {
      gateway.gates.after = 1;
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const call = execute(a, ChargeWorkflowStart, { text: "order-7 alice@example.com" });
      call.catch(() => undefined);
      await frozenCharges(1);
      leases.stall(a);
      await clock.advance(seconds(31));
      await clock.advance(seconds(31));
      const [end] = await ends(1);

      expect(end?.output).toEqual({ chargeId: "ch-order-7-1" });
      expect(runs.outcomes).toEqual([{ status: OutboundCallOutcomeStatus.Reconciled, attempt: 1 }]);
      expect(gateway.calls).toHaveLength(1);
      expect(await b.outboundCallsOf(TREE)).toEqual([
        expect.objectContaining({
          status: OutboundCallStatus.Completed,
          token: 2,
          request: '{"orderId":"order-7","amountUsd":10,"email":"<email>"}',
        }),
      ]);
      const rows = await b.leaseEventsOf(TREE);
      expect(
        rows.flatMap((row) =>
          row.kind === ExecutionLeaseEventKind.OutboundCall ? [row.outcome] : [],
        ),
      ).toEqual([OutboundCallEventOutcome.Recorded, OutboundCallEventOutcome.Reconciled]);

      letChargesGo();
      leases.resume(a);
      await settle();
      expect(await rejectionOf(call)).toBeInstanceOf(ExecutionLeaseLostError);
      expect(gateway.calls).toHaveLength(1);
    },
  );
});

const assembledWith = (providers: readonly Provider[]) => {
  @Application({
    name: "outbound-stores-application",
    version: "1.0.0",
    environment: SqliteTestEnvironment,
    workflows: [ChargeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [SqliteConnection, ...providers],
  })
  class OutboundStoresApplication {}
  return applicationOf(OutboundStoresApplication);
};

describe("#505, #526: [application.store-backend-mismatch] for the outbound-call store", () => {
  it("the SQLite store beside the in-memory leases fails assembly, naming both", async () => {
    await expect(assembledWith([SqliteOutboundCallRepository])).rejects.toThrow(
      '[application.store-backend-mismatch] SqliteOutboundCallRepository (backend "sqlite") checks its leases in its own transaction, but the application\'s leases are in InMemoryExecutionLeaseRepository (backend "in-memory")',
    );
  });

  it("the SQLite store with the SQLite leases assembles", async () => {
    const assembled = await assembledWith([
      SqliteOutboundCallRepository,
      SqliteExecutionLeaseRepository,
    ]);

    expect(assembled.providers).toContain(SqliteOutboundCallRepository);
  });

  it("the in-memory store listed beside the SQLite leases fails assembly", async () => {
    await expect(
      assembledWith([InMemoryOutboundCallRepository, SqliteExecutionLeaseRepository]),
    ).rejects.toThrow(
      'InMemoryOutboundCallRepository (backend "in-memory") checks its leases in its own transaction, but the application\'s leases are in SqliteExecutionLeaseRepository (backend "sqlite")',
    );
  });
});

describe("#505: the unlisted default beside SQLite leases", () => {
  testWith(UnlistedOutboundCallStoreApplication)(
    "is not an assembly error; the first call fails with FencedEffectStoreMismatchError, nothing sent",
    async ({ app }) => {
      const error = await execute(app, ChargeWorkflowStart, { text: "order-1" }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ActionFailedError);
      expect(error).toMatchObject({
        cause: {
          code: "fenced-effect.store-mismatch",
          fencedEffectRepository: "InMemoryOutboundCallRepository",
          leaseRepository: "SqliteExecutionLeaseRepository",
        },
      });
      expect((error as ActionFailedError).cause).toBeInstanceOf(FencedEffectStoreMismatchError);
      expect(gateway.calls).toEqual([]);
    },
  );
});
