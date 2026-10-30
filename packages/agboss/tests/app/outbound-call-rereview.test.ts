/**
 * #508 — the re-review of the outbound-call protocol, one scenario per finding: a send that never
 * returns bounds close, cancel and the other instance's wait; a result not stored is never replayed
 * as one; a live attempt blocks a yield; nothing read or exported carries a fingerprint; a
 * Superseded attempt is logged on the instance's log; a joined call is told apart by `instanceof`
 * alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EmptyEnvironment,
  ExecutionHistoryRepository,
  ExecutionLeaseRepository,
  Injectable,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  type FencedEffectKey,
  Logger,
  OutboundCallRepository,
  OutboundCallOutcomeStatus,
  OutboundCallResultNotStoredError,
  OutboundCallStatus,
} from "../../src/index.js";
import { maskedTextOf } from "../../src/app/outbound-call-parts.js";
import { superseded } from "../../src/app/outbound-call-endings.js";
import { joinedOrMade } from "../../src/app/outbound-call-join.js";
import { getEventListeners } from "node:events";
import { stateOf } from "../../src/app/outbound-call-business.js";
import { Clock } from "../../src/infrastructure/clock.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { ChargeOrderAction } from "./fixtures/outbound-call.workflow.js";
import { REDACTED } from "../../src/app/outbound-calls.js";
import { override, testAction, testWith } from "../../src/testing/index.js";
import { hours, kilobytes, minutes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, RecordingLogger, recordingLog, resetLogged } from "../helpers/log.js";
import { instance, settle } from "./fixtures/fence-takeover.js";
import {
  BusinessKeyApplication,
  CashierWorkflow,
  ChargeOrderWorkflow,
  ledger,
  letLedgerGo,
  resetLedger,
  SendChargeStart,
  SendChargesWorkflow,
  SendChargeWorkflow,
} from "./fixtures/business-key.workflow.js";
import { heard, OutboundCallLog, resetRuns } from "./fixtures/outbound-call.workflow.js";
import { Application } from "../../src/application/application.js";
import {
  exportedRecordLine,
  historyRecordsOf,
} from "../../src/infrastructure/execution-history-export.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { gateway, letChargesGo, resetGateway } from "./fixtures/payment-gateway.js";

const overrides = [override(Logger, RecordingLogger)];
const test = testWith(BusinessKeyApplication, { overrides });
const two = testWith(BusinessKeyApplication, { instances: 2, overrides });
const charge = { orderId: "42", amountUsd: 10 };

/** Until `count` outbound charges of the business-key fixture are frozen. */
async function frozenLedger(count: number): Promise<void> {
  for (let tick = 0; tick < 2000 && ledger.frozen.length < count; tick += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (ledger.frozen.length < count) throw new Error(`${String(count)} charges never froze`);
}

/** A charge that never returns, whatever its step's signal says. */
function hungCharge(): void {
  Object.assign(ledger, { freeze: 1, ignoresAbort: true });
}

/** Whether `promise` settled — either way — once the steps of `advance` ran. */
function settledFlag(promise: Promise<unknown>): () => boolean {
  let isSettled = false;
  promise.then(
    () => (isSettled = true),
    () => (isSettled = true),
  );
  return () => isSettled;
}

/** The business-key application, its root executions kept (#401) and its calls heard. */
@Application({
  name: "kept-business-key-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CashierWorkflow, ChargeOrderWorkflow, SendChargeWorkflow, SendChargesWorkflow],
  providers: [...MODEL_PROVIDERS, InMemoryFencedEffectRepository],
  budgets: TEST_BUDGETS,
  observers: [OutboundCallLog],
  executionRecordRetention: hours(24),
})
class KeptBusinessKeyApplication {}

const kept = testWith(KeptBusinessKeyApplication);

beforeEach(() => {
  resetRuns();
  resetLedger();
  resetGateway();
  resetLogged();
});

afterEach(() => {
  letLedgerGo();
  letChargesGo();
});

describe("#508 re-review HIGH1: a send that never returns bounds every wait on it", () => {
  test("close with a hung send: done at its timeout, the lease left to expire — never released under the attempt", async ({
    app,
    clock,
  }) => {
    await app.ready();
    hungCharge();
    execute(app, SendChargeStart, charge, { threadId: "thread-hung" }).catch(() => undefined);
    await frozenLedger(1);

    const isClosed = settledFlag(app.close({ timeout: seconds(10) }));
    for (let tick = 0; tick < 3 && !isClosed(); tick += 1) {
      await clock.advance(seconds(5));
      await settle();
    }

    expect(isClosed()).toBe(true);
  });

  test("cancel with a hung send: the cancel returns, and the execution settles once the attempt's timeout bounds its wait — never hung", async ({
    app,
    clock,
  }) => {
    await app.ready();
    hungCharge();
    const isDone = settledFlag(execute(app, SendChargeStart, charge, { threadId: "thread-c" }));
    await frozenLedger(1);

    const isCancelled = settledFlag(app.cancel("thread-c", { tenantId: "default" }));
    for (let tick = 0; tick < 20 && !(isCancelled() && isDone()); tick += 1) {
      await clock.advance(seconds(10));
      await settle();
    }

    expect(isCancelled()).toBe(true);
    expect(isDone()).toBe(true);
  });

  two(
    "after the attempt's timeout and the lease's expiry, the other instance takes the lease over and settles the call",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await Promise.all([a.ready(), b.ready()]);
      hungCharge();
      execute(a, SendChargeStart, charge, { threadId: "thread-a" }).catch(() => undefined);
      await frozenLedger(1);
      void a.cancel("thread-a", { tenantId: "default" }).catch(() => undefined);
      for (let tick = 0; tick < 6; tick += 1) {
        await clock.advance(minutes(1));
        await settle();
      }

      const settledByB = await execute(b, SendChargeStart, charge);

      expect(settledByB.output).toEqual({ chargeId: "ch-42-1" });
      expect(gateway.calls).toHaveLength(1);
    },
  );

  two(
    "the hung send returns after the takeover: its answer is fenced — not stored — and logged as an error",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await Promise.all([a.ready(), b.ready()]);
      hungCharge();
      const first = execute(a, SendChargeStart, charge, { threadId: "thread-late" });
      first.catch(() => undefined);
      await frozenLedger(1);
      void a.cancel("thread-late", { tenantId: "default" }).catch(() => undefined);
      for (let tick = 0; tick < 6; tick += 1) {
        await clock.advance(minutes(1));
        await settle();
      }
      await execute(b, SendChargeStart, charge);

      letLedgerGo();
      await first.catch(() => undefined);
      await settle();
      const replayed = await execute(b, SendChargeStart, charge);

      expect(gateway.calls).toHaveLength(2);
      expect(ledger.outbound.at(-1)).toBe(OutboundCallOutcomeStatus.Replayed);
      expect(replayed.output).toEqual({ chargeId: "ch-42-1" });
      expect(logged).toContainEqual(
        expect.objectContaining({
          level: "error",
          code: "outbound-call.answered-after-hand-over",
          message: expect.stringContaining('outbound call "charge" (charge on payments) attempt 1'),
        }),
      );
    },
  );
});

describe("#508 re-review HIGH2: a result not stored is never replayed as one", () => {
  test("a result above maxPayloadSize: the first call gets its answer and a warning is logged; the next under the key fails with OutboundCallResultNotStoredError, nothing sent again", async ({
    app,
  }) => {
    gateway.padding = kilobytes(65);
    const first = await execute(app, SendChargeStart, charge);
    gateway.padding = 0;

    const again = execute(app, SendChargeStart, charge);

    await expect(again).rejects.toFailWith(OutboundCallResultNotStoredError, {
      call: "charge",
      reason: "outbound-call.payload-too-large",
    });
    expect(first.output).toMatchObject({ chargeId: expect.stringMatching(/^ch-42-1x+$/u) });
    const [call] = await app.outboundCallsOf({
      tenantId: "default",
      rootExecutionId: first.executionId,
    });
    expect(call?.status).toBe(OutboundCallStatus.Completed);
    expect(gateway.calls).toHaveLength(1);
    expect(logged).toContainEqual(
      expect.objectContaining({ level: "warn", code: "outbound-call.result-not-stored" }),
    );
  });

  it("a text stored [redacted] — no mask could be applied — is logged as a warning, naming the call only", async () => {
    const { log, entries } = recordingLog();
    const run = {
      frame: { execution: { executionId: "execution-1", observability: undefined } },
      parts: { settings: { requiresMask: true }, log },
      key: { name: "charge", tenantId: "default" },
      options: { target: "payments", operation: "charge" },
    } as never;

    expect(await maskedTextOf(run, "card of ann@example.com declined")).toBe(REDACTED);
    expect(entries).toEqual([
      expect.objectContaining({ level: "warn", code: "outbound-call.text-redacted" }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("ann@example.com");
  });
});

describe("#508 re-review MEDIUM4: a fingerprint is kept in the store's row only", () => {
  kept(
    "no read, kept record, export, lease-log row or event carries the fingerprint — the store's row does",
    async ({ app }) => {
      Object.assign(ledger, { freeze: 1 });
      const pending = execute(app, SendChargeStart, charge, { threadId: "thread-pending" });
      pending.catch(() => undefined);
      await frozenLedger(1);
      const whilePending = await app.pendingOutboundCalls({ tenantId: "default" });
      letLedgerGo();
      const result = await pending;
      const tree = { tenantId: "default", rootExecutionId: result.executionId };
      const query = {
        tenantId: "default",
        from: new Date(0),
        to: new Date("2100-01-01T00:00:00Z"),
      };
      const lines: string[] = [];
      for await (const record of historyRecordsOf(app.resolve(ExecutionHistoryRepository), query))
        lines.push(exportedRecordLine(record));
      const keptRecord = await app
        .resolve(ExecutionHistoryRepository)
        .findByTenantIdAndExecutionId("default", result.executionId);

      const shown = [
        whilePending,
        await app.outboundCallsOf(tree),
        await app.leaseEventsOf(tree),
        keptRecord?.outboundCalls,
        heard.events,
      ];
      const [row] = await app
        .resolve(OutboundCallRepository)
        .findAllByTenantIdAndRootExecutionId("default", result.executionId);
      expect(row?.fingerprint).toEqual(expect.any(String));
      expect(whilePending).toHaveLength(1);
      expect(keptRecord?.outboundCalls).toHaveLength(1);
      expect(heard.events.length).toBeGreaterThan(0);
      for (const surface of [...shown.map((value) => JSON.stringify(value)), ...lines]) {
        expect(surface).not.toContain("fingerprint");
        expect(surface).not.toContain(row?.fingerprint);
      }
    },
  );
});

/** The rival that takes the attempt over between this call's send and its completion. */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
class SupersedingOutboundCallRepository extends InMemoryOutboundCallRepository {
  override async markCompleted(key: FencedEffectKey, owner: string, result: string) {
    const found = await this.findByKey(key);
    if (found !== undefined)
      await this.markPending(key, stateOf(found), {
        attempt: found.attempt + 1,
        attemptOwner: "x",
      });
    return super.markCompleted(key, owner, result);
  }
}

describe("#508 re-review LOW/MEDIUM6: a Superseded attempt is logged on the instance's log", () => {
  it("with no lease log (a unit runner): the error is logged all the same, naming the newer attempt", async () => {
    const run = testAction(ChargeOrderAction, {
      overrides: [
        override(OutboundCallRepository, SupersedingOutboundCallRepository),
        override(Logger, RecordingLogger),
      ],
    });

    await run({ message: { value: { text: "order-1" } } } as never);

    expect(logged).toEqual([
      expect.objectContaining({
        level: "error",
        code: "outbound-call.superseded",
        message: expect.stringContaining(
          "attempt 1 was answered after attempt 2 took its intent over",
        ),
      }),
    ]);
  });

  it('the intent can no longer be read: the newer attempt is "unknown", never a guess', async () => {
    const { log, entries } = recordingLog();
    const run = {
      frame: { execution: { executionId: "execution-1" } },
      parts: { repository: { findByKey: () => Promise.reject(new Error("fenced")) }, log },
      key: { name: "charge", tenantId: "default" },
      options: { target: "payments", operation: "charge" },
    } as never;

    await superseded(run, 1);

    expect(entries).toEqual([expect.objectContaining({ code: "outbound-call.superseded" })]);
    expect(entries[0]?.message).toContain("after a newer attempt (which one is unknown)");
    expect(entries[0]?.message).not.toContain("attempt 2");
  });
});

/** A run of call `charge` whose first call — made by this instance now — ends as `outcome`. */
function joiningRun(outcome: Promise<unknown>, isAnswered: boolean) {
  const controller = new AbortController();
  const key = { name: "charge", tenantId: "default", scopeKey: "s", idempotencyKey: "k" };
  const liveKey = "default\u0000s\u0000k\u0000charge";
  const live = new Map([[liveKey, { fingerprint: undefined, outcome, answer: { isAnswered } }]]);
  // a failed first call leaves the live calls, as its own `joinedOrMade` does; a sent one stays
  outcome.catch(() => live.delete(liveKey));
  const run = {
    parts: { live },
    key,
    frame: { execution: { signal: controller.signal, lease: undefined } },
    options: { target: "payments", operation: "charge" },
    idempotencyKey: "k:charge",
    answer: { isAnswered: false },
  } as never;
  return { run, signal: controller.signal };
}

/** A promise rejected with `value` as it is — what a client that throws a string gives. */
const rejectedWith = (value: unknown): Promise<never> =>
  Promise.resolve({
    then: (_: unknown, reject: (reason: unknown) => void) => {
      reject(value);
    },
  } as PromiseLike<never>);

describe("#508 re-review LOW: a joined call", () => {
  it("shares the other system's error whatever was thrown — a string too — and never makes its own call", async () => {
    const { run } = joiningRun(rejectedWith("card declined"), true);
    let isMade = false;

    const joined = joinedOrMade(run, () => {
      isMade = true;
      return Promise.reject(new Error("made"));
    });

    await expect(joined).rejects.toBe("card declined");
    expect(isMade).toBe(false);
  });

  it("makes its own call when the first ended with an error of its own (not the other system's), a string too", async () => {
    const { run } = joiningRun(rejectedWith("handed over"), false);
    const made = {
      status: OutboundCallOutcomeStatus.Sent,
      result: 1,
      attempt: 1,
      idempotencyKey: "k",
    };

    await expect(joinedOrMade(run, () => Promise.resolve(made))).resolves.toBe(made);
  });

  it("leaves no abort listener on its step's signal once it joined", async () => {
    const first = {
      status: OutboundCallOutcomeStatus.Sent,
      result: 1,
      attempt: 1,
      idempotencyKey: "k",
    };
    const { run, signal } = joiningRun(Promise.resolve(first), false);
    const before = getEventListeners(signal, "abort").length;

    for (let join = 0; join < 3; join += 1)
      await joinedOrMade(run, () => Promise.reject(new Error("not made")));

    expect(getEventListeners(signal, "abort")).toHaveLength(before);
  });
});
