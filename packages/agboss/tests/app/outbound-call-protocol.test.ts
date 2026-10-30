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
  ExecutionContext,
  ExecutionContextUnavailableError,
  ExecutionFencedError,
  ExecutionLeaseLostError,
  fencedEffectKeyOf,
  OutboundCallReconciliation,
  OutboundCallVerdict,
  OutboundCalls,
  OutboundCallSettings,
  OutboundCallUnreconciledError,
  InMemoryOutboundCallRepository,
  OutboundCallStatus,
} from "../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { testAction, VirtualClock } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { ChargeOrderAction, resetRuns, runs } from "./fixtures/outbound-call.workflow.js";
import {
  gateway,
  letChargesGo,
  LookupMode,
  PaymentDeclinedError,
  PaymentGateway,
  resetGateway,
} from "./fixtures/payment-gateway.js";

beforeEach(() => {
  resetGateway();
  resetRuns();
});

afterEach(letChargesGo);

const order = { message: { value: { text: "order-1" } } } as never;
const KEY = "test-execution:charge-order-action:1:charge";

/** A key of a lease scope, made by hand outside any step. */
const KEY_PARTS = {
  scopeKey: "default:execution-1",
  tenantId: "default",
  leaseExecutionId: "execution-1",
  token: 1,
  idempotencyKey: "execution-1:charge-action:1",
  name: "charge",
};

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

  it("unknown: OutboundCallUnreconciledError naming the call, nothing sent, still pending", async () => {
    const run = await leftPending("after");
    gateway.lookup = LookupMode.Unknown;

    const failure = await run(order).catch((error: unknown) => error);
    const again = await run(order).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OutboundCallUnreconciledError);
    expect(failure).toMatchObject({
      code: "outbound-call.unreconciled",
      call: "charge",
      target: "payments",
      operation: "charge",
      idempotencyKey: KEY,
      reason: "the bank has not settled it",
      nodeId: "charge-order-action",
    });
    expect(String(failure)).toMatch(
      /left pending and could not be reconciled: the bank has not settled it/,
    );
    expect(again).toBeInstanceOf(OutboundCallUnreconciledError);
    expect(gateway.lookups).toHaveLength(2);
    expect(gateway.calls).toHaveLength(1);
  });

  it("reconcile throws: the same error, the hook's error its cause", async () => {
    const run = await leftPending("after");
    gateway.lookup = LookupMode.Throws;

    const failure = await run(order).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OutboundCallUnreconciledError);
    expect(failure).toMatchObject({
      reason: "reconcile threw: the provider's lookup is down",
      cause: { message: "the provider's lookup is down" },
    });
  });

  it("reconcile gives a plain object, not a verdict: the same error", async () => {
    const run = await leftPending("after");
    gateway.lookup = LookupMode.NoVerdict;

    await expect(run(order)).rejects.toMatchObject({
      reason: "reconcile gave no OutboundCallReconciliation verdict",
    });
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("#505: the lease before the network", () => {
  it("a renewal that fails right before the call: nothing sent, the intent pending for the next holder", async () => {
    const failing = testAction(ChargeOrderAction, { fence: { confirmNowFails: true } });

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
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
class TwiceAtOnceAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(): Promise<void> {
    const key = fencedEffectKeyOf(this.executionContext, "charge");
    const options = {
      target: "payments",
      operation: "charge",
      request: { orderId: "order-2", amountUsd: 10 },
      send: (call: Parameters<PaymentGateway["charge"]>[0]) => this.paymentGateway.charge(call),
      reconcile: (lookup: Parameters<PaymentGateway["reconcile"]>[0]) =>
        this.paymentGateway.reconcile(lookup),
    };
    await Promise.all([
      this.outboundCalls.send(key, options),
      this.outboundCalls.send(key, options),
    ]);
  }
}

describe("#505: what the protocol refuses", () => {
  it("one key sent twice at once in a step: the second is refused, the provider called once", async () => {
    const run = testAction(TwiceAtOnceAction);

    await expect(run(order)).rejects.toMatchObject({
      code: "outbound-call.in-flight",
      call: "charge",
    });
    expect(gateway.calls).toHaveLength(1);
  });

  it("outside a step: ExecutionContextUnavailableError, nothing recorded", async () => {
    const [clock, database] = [new VirtualClock(), new InMemoryDatabase()];
    const application = applicationContextOf({
      ...{ name: "outside-application", version: "1.0.0", instanceId: "instance-1" },
      ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
    });
    const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
    const store = new InMemoryOutboundCallRepository(clock, database, leases);
    const outboundCalls = new OutboundCalls(store, new OutboundCallSettings());

    const refused = outboundCalls.send(KEY_PARTS, {
      target: "payments",
      operation: "charge",
      request: {},
      send: () => ({}),
      reconcile: () => OutboundCallReconciliation.notSent(),
    });

    await expect(refused).rejects.toBeInstanceOf(ExecutionContextUnavailableError);
    expect(await store.findAllByTenantIdAndStatus("default", OutboundCallStatus.Pending)).toEqual(
      [],
    );
  });

  it("a verdict is built only by its factories", () => {
    const completed = OutboundCallReconciliation.completed({ chargeId: "ch-1" });
    const shape = { verdict: OutboundCallVerdict.Completed, result: undefined, reason: "" };
    // @ts-expect-error — a plain object is not a verdict: it is nominal
    const plain: OutboundCallReconciliation<{ chargeId: string }> = shape;

    expect(completed).toMatchObject({
      verdict: "completed",
      result: { chargeId: "ch-1" },
      reason: "",
    });
    expect(OutboundCallReconciliation.notSent()).toMatchObject({ verdict: "not-sent" });
    expect(OutboundCallReconciliation.unknown({ reason: "why" })).toMatchObject({
      verdict: "unknown",
      reason: "why",
    });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(plain).not.toBeInstanceOf(OutboundCallReconciliation);
  });
});
