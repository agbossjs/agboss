import { OutboundCallError } from "../../src/core/error-families/effect-errors.js";
import { SilentLogger } from "../../src/infrastructure/logger.js";
/**
 * #505 — the protocol of a call that leaves the system, edge by edge, in a unit runner: the action
 * of the application test on the built-in in-memory store, its lease the runner's. A second run of
 * one runner is the same step run again (one idempotency key), so each verdict and fault is
 * reproduced without a crash: a send aborted by its timeout leaves the intent pending, as a process
 * killed before the answer does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  ExecutionContextUnavailableError,
  ExecutionFencedError,
  ExecutionLeaseLostError,
  Idempotency,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  OutboundCallSendStatus,
  OutboundCallStatus,
  OutboundRecovery,
  Reconciliation,
} from "../../src/index.js";
import { OutboundMasking } from "../../src/app/outbound-masking.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { testAction, VirtualClock } from "../../src/testing/index.js";
import { hours, seconds } from "../../src/units/index.js";
import { ChargeOrderAction, resetRuns, runs } from "./fixtures/outbound-call.workflow.js";
import {
  gateway,
  letChargesGo,
  LookupMode,
  PaymentDeclinedError,
  PaymentGateway,
  resetGateway,
} from "./fixtures/payment-gateway.js";
import { isReconciliation, ReconciliationVerdict } from "../../src/app/outbound-recovery.js";
import { storeClockOf } from "../helpers/store-clock.js";

beforeEach(() => {
  resetGateway();
  resetRuns();
});

afterEach(letChargesGo);

const order = { message: { value: { text: "order-1" } } } as never;
const KEY = "test-execution:charge-order-action:1:charge";

/** A runner whose first run's call is left pending: frozen at the provider, its timeout fired. */
async function leftPending(side: "before" | "after") {
  const run = testAction(ChargeOrderAction);
  gateway.gates[side] = 1;
  const first = run(order, { timeout: seconds(1) });
  first.catch(() => undefined);
  await run.clock.advance(seconds(1));
  await expect(first).rejects.toThrow();
  return run;
}

describe("#505: send and replay in one step", () => {
  it("sends once, then a second run of the step replays the stored result: nothing sent", async () => {
    const run = testAction(ChargeOrderAction);

    const first = await run(order);
    const second = await run(order);

    expect(second.output).toEqual(first.output);
    expect(runs.outcomes.map((outcome) => outcome.status)).toEqual(["sent", "replayed"]);
    expect(gateway.calls).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
  });
});

describe("#505: the provider answers with an error, then a retry", () => {
  it("the error is rethrown; the step run again sends attempt 2 with the same key, no reconcile", async () => {
    gateway.failNext = 1;
    const run = testAction(ChargeOrderAction);

    await expect(run(order)).rejects.toBeInstanceOf(PaymentDeclinedError);
    const retry = await run(order);

    expect(retry.output).toEqual({ chargeId: "ch-order-1-1" });
    expect(gateway.calls).toEqual([
      { idempotencyKey: KEY, attempt: 1 },
      { idempotencyKey: KEY, attempt: 2 },
    ]);
    expect(gateway.lookups).toEqual([]);
  });
});

describe("#505: an intent left pending, reconciled", () => {
  it("a send aborted before the answer is not a failure: the intent stays pending and is reconciled", async () => {
    const run = await leftPending("before");

    const again = await run(order);

    expect(gateway.lookups).toEqual([{ idempotencyKey: KEY, attempt: 1 }]);
    expect(runs.outcomes).toEqual([{ status: "sent", attempt: 2 }]);
    expect(again.output).toEqual({ chargeId: "ch-order-1-1" });
  });

  it("completed: the provider's receipt, nothing sent again (Reconciled)", async () => {
    const run = await leftPending("after");

    const again = await run(order);

    expect(again.output).toEqual({ chargeId: "ch-order-1-1" });
    expect(runs.outcomes).toEqual([{ status: "reconciled", attempt: 1 }]);
    expect(gateway.calls).toHaveLength(1);
  });

  it("unknown: OutboundCallError.Unreconciled naming the call, nothing sent, still pending", async () => {
    const run = await leftPending("after");
    gateway.lookup = LookupMode.Unknown;

    const failure = await run(order).catch((error: unknown) => error);
    const again = await run(order).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OutboundCallError.Unreconciled);
    expect(failure).toMatchObject({
      code: "outbound-call.unreconciled",
      call: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: KEY,
      reason: "reconcile.unknown",
      detail: "the bank has not settled it",
    });
    expect(String(failure)).toMatch(
      /left pending and could not be reconciled \(reconcile\.unknown\): the bank has not settled it/,
    );
    expect(again).toBeInstanceOf(OutboundCallError.Unreconciled);
    expect(gateway.lookups).toHaveLength(2);
    expect(gateway.calls).toHaveLength(1);
  });

  it("reconcile throws: the same error, the hook's error its cause", async () => {
    const run = await leftPending("after");
    gateway.lookup = LookupMode.Throws;

    const failure = await run(order).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OutboundCallError.Unreconciled);
    expect(failure).toMatchObject({
      reason: "reconcile.threw",
      detail: "the lookup threw: the provider's lookup is down",
      cause: { message: "the provider's lookup is down" },
    });
  });

  it("reconcile gives a plain object, not a verdict: the same error", async () => {
    const run = await leftPending("after");
    gateway.lookup = LookupMode.NoVerdict;

    await expect(run(order)).rejects.toMatchObject({
      reason: "reconcile.no-verdict",
      detail: "the lookup gave no Reconciliation verdict",
    });
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("#505: the lease before the network", () => {
  it("a renewal that fails right before the call: nothing sent, the intent pending for the next holder", async () => {
    const failing = testAction(ChargeOrderAction, { fence: { renewNowFails: true } });

    await expect(failing(order)).rejects.toBeInstanceOf(ExecutionLeaseLostError);

    expect(gateway.calls).toEqual([]);
  });

  it("a lost lease: refused before anything is recorded or sent", async () => {
    const lost = testAction(ChargeOrderAction, { fence: { isLost: true } });

    await expect(lost(order)).rejects.toBeInstanceOf(ExecutionFencedError);
    expect(gateway.calls).toEqual([]);
  });
});

@Action({
  name: "twice-at-once-action",
  description: "Sends one call from two places of one step at once",
  input: { message: WorkflowStartTextDto },
  deps: [Idempotency, PaymentGateway],
})
class TwiceAtOnceAction {
  constructor(
    private readonly idempotency: Idempotency,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(): Promise<void> {
    const options = {
      name: "charge",
      timeout: seconds(15),
      ttl: hours(48),
      target: "payments",
      operation: "charge",
      request: { orderId: "order-2", amountUsd: 10 },
      send: (call: Parameters<PaymentGateway["charge"]>[0]) => this.paymentGateway.charge(call),
      recovery: OutboundRecovery.permanentLookup(
        (lookup: Parameters<PaymentGateway["reconcile"]>[0]) =>
          this.paymentGateway.reconcile(lookup),
      ),
    };
    const outcomes = await Promise.allSettled([
      this.idempotency.sendOnce(options),
      this.idempotency.sendOnce(options),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
      runs.outcomes.push({ status: outcome.value.status, attempt: outcome.value.attempt });
    }
  }
}

describe("#505: what the protocol refuses", () => {
  it("one key sent twice at once in a step: the second joins the first, the provider called once", async () => {
    const run = testAction(TwiceAtOnceAction);

    await run(order);

    expect(runs.outcomes).toEqual([
      { status: OutboundCallSendStatus.Sent, attempt: 1 },
      { status: OutboundCallSendStatus.Joined, attempt: 1 },
    ]);
    expect(gateway.calls).toHaveLength(1);
  });

  it("a joined call gets the first call's error, the provider called once", async () => {
    const run = testAction(TwiceAtOnceAction);
    gateway.failNext = 1;

    await expect(run(order)).rejects.toBeInstanceOf(PaymentDeclinedError);
    expect(gateway.calls).toHaveLength(1);
  });

  it("outside a step: ExecutionContextUnavailableError, nothing recorded", async () => {
    const [clock, database] = [new VirtualClock(), new InMemoryDatabase()];
    const application = applicationContextOf({
      ...{ name: "outside-application", version: "1.0.0", instanceId: "instance-1" },
      ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
    });
    const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), application, database);
    const store = new InMemoryOutboundCallRepository(storeClockOf(clock), database, leases);
    const effects = new InMemoryFencedEffectRepository(storeClockOf(clock), database, leases);
    const idempotency = new Idempotency(
      effects,
      store,
      new OutboundMasking({ requiresMask: false }),
      new SilentLogger(),
      clock,
    );

    const refused = idempotency.sendOnce({
      name: "charge",
      target: "payments",
      operation: "charge",
      request: {},
      timeout: seconds(15),
      ttl: hours(48),
      send: () => ({}),
      recovery: OutboundRecovery.permanentLookup<object>(() => Reconciliation.notExecuted()),
    });

    await expect(refused).rejects.toBeInstanceOf(ExecutionContextUnavailableError);
    expect(
      (
        await store.findAllByTenantIdAndStatus({
          tenantId: "default",
          status: OutboundCallStatus.Pending,
          limit: 1000,
        })
      ).items,
    ).toEqual([]);
  });

  it("a verdict is built only by its factories", () => {
    const completed = Reconciliation.completed({ chargeId: "ch-1" });
    const shape = { verdict: ReconciliationVerdict.Completed, result: { chargeId: "ch-1" } };
    // @ts-expect-error — a plain object is not a verdict: it is nominal
    const plain: Reconciliation<{ chargeId: string }> = shape;

    expect(completed).toEqual({ verdict: "completed", result: { chargeId: "ch-1" } });
    expect(Reconciliation.notExecuted()).toMatchObject({ verdict: "not-executed" });
    expect(Reconciliation.unknown("why")).toMatchObject({ verdict: "unknown", reason: "why" });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(isReconciliation(plain)).toBe(false);
    expect(isReconciliation(completed)).toBe(true);
  });
});
