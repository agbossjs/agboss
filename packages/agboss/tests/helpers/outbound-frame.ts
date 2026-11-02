import type { OutboundCallReport } from "../../src/app/lease-events.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { runInFrame, type FrameLease, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  InMemoryOutboundCallRepository,
  OutboundCallReconciliation,
  OutboundCalls,
  OutboundCallSettings,
  type Clock,
  type FencedEffectKey,
  type OutboundCallLookup,
  type OutboundCallOptions,
  type OutboundCallOutcome,
} from "../../src/index.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import type { FakeOutboundGateway } from "../../src/testing/gateway/fake-outbound-gateway.js";
import { hours } from "../../src/units/index.js";
import { testFrame } from "./frame.js";
import { Logger, type LogEntry } from "../../src/infrastructure/logger.js";

/**
 * #657, #658 — `OutboundCalls` in a step's frame made by hand over the in-memory stores, on a test's
 * `VirtualClock` (the stores' time; an instance's own clock may be skewed from it): leases taken and
 * released by hand, so one call can be left by an execution that ended and taken up by another.
 */

/** A lease that outlives every key the tests age (a key days old, its lease still held). */
const LONG_LEASE = hours(24 * 30);

/** A `Logger` that keeps its entries. */
class KeptLogger extends Logger {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

/** How the frame is made: the instance's own clock (default: the stores'), its settings, its store. */
export interface OutboundFrameOptions {
  readonly instanceClock?: (clock: VirtualClock) => Clock;
  readonly settings?: OutboundCallSettings;
  readonly store?: typeof InMemoryOutboundCallRepository;
}

/** A taken lease and the key of a call under it. */
export interface KeyedLease {
  readonly lease: ExecutionLease;
  readonly key: FencedEffectKey;
}

/** One instance's stores and `OutboundCalls`, with what its frame was told and its log. */
export interface OutboundFrame {
  /** The stores' time, and the instance's unless `instanceClock` skews it. */
  readonly clock: VirtualClock;
  readonly store: InMemoryOutboundCallRepository;
  readonly leases: InMemoryExecutionLeaseRepository;
  readonly reports: OutboundCallReport[];
  readonly logger: { readonly entries: LogEntry[] };
  readonly keyIn: (executionId: string, businessKey?: string) => Promise<KeyedLease>;
  readonly send: <TRequest, TResult>(
    key: FencedEffectKey,
    callOptions: OutboundCallOptions<TRequest, TResult>,
  ) => Promise<OutboundCallOutcome<TResult>>;
}

/** The stores of one instance, its `OutboundCalls`, and a step's frame that keeps what it is told. */
export function outboundFrame(options: OutboundFrameOptions = {}): OutboundFrame {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "outbound-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(clock, application, database);
  const Store = options.store ?? InMemoryOutboundCallRepository;
  const store = new Store(clock, database, leases);
  const reports: OutboundCallReport[] = [];
  const lease: FrameLease = {
    tenantId: "default",
    leaseExecutionId: "execution-1",
    scopeKey: "default:execution-1",
    token: 1,
    confirmedUntil: Number.POSITIVE_INFINITY,
    isYielded: false,
    assertHeld: () => undefined,
    confirmNow: () => Promise.resolve(),
    enterStep: () => Promise.resolve(() => undefined),
    recordOutboundCall: (report) => {
      reports.push(report);
    },
  };
  const base = testFrame();
  const frame: FrameSpec = { ...base, execution: { ...base.execution, lease } };
  const origin = { executionId: base.execution.executionId, nodeId: "pay-action", visitNumber: 1 };
  const logger = new KeptLogger();
  const settings = options.settings ?? new OutboundCallSettings();
  const instanceClock = options.instanceClock?.(clock) ?? clock;
  const calls = new OutboundCalls(store, settings, logger, instanceClock);
  /** The lease of `executionId` taken, and the call's key under it — `order:42` by default. */
  const keyIn = async (executionId: string, businessKey = "order:42"): Promise<KeyedLease> => {
    const taken = await leases.acquire("default", executionId, LONG_LEASE);
    if (taken === undefined) throw new Error(`the lease of ${executionId} is held`);
    return { lease: taken, key: { ...keyOf(taken), origin, businessKey } };
  };
  /** `calls.send` in the step's frame. */
  const send = <TRequest, TResult>(
    key: FencedEffectKey,
    callOptions: OutboundCallOptions<TRequest, TResult>,
  ): Promise<OutboundCallOutcome<TResult>> => runInFrame(frame, () => calls.send(key, callOptions));
  return { clock, store, leases, reports, logger, keyIn, send };
}

/** `promise`'s rejection; the test fails when it resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

/** What the tests charge: an amount. */
export interface GatewayChargeRequest {
  readonly amount: number;
}

/** The gateway's receipt, as the step keeps it. */
export interface GatewayPaymentReceipt {
  readonly paymentId: string;
}

/**
 * A reconcile by a reference that does not expire: the gateway's own record of every payment it
 * made (its books), not its key store — as a lookup by the merchant reference is.
 */
export const byReference =
  (gateway: FakeOutboundGateway) =>
  (lookup: OutboundCallLookup): OutboundCallReconciliation<GatewayPaymentReceipt> => {
    const found = gateway.payments.find(
      (payment) => payment.idempotencyKey === lookup.idempotencyKey,
    );
    return found === undefined
      ? OutboundCallReconciliation.notSent()
      : OutboundCallReconciliation.completed({ paymentId: found.paymentId });
  };

/** A charge of 10 at `gateway`, reconciled by reference, with `extra` options over it. */
export const gatewayCharge = (
  gateway: FakeOutboundGateway,
  extra: Partial<OutboundCallOptions<GatewayChargeRequest, GatewayPaymentReceipt>> = {},
): OutboundCallOptions<GatewayChargeRequest, GatewayPaymentReceipt> => ({
  target: "gateway",
  operation: "charge",
  request: { amount: 10 },
  send: async (call) => {
    const receipt = await gateway.charge({ amount: 10, idempotencyKey: call.idempotencyKey });
    return { paymentId: receipt.paymentId };
  },
  reconcile: byReference(gateway),
  ...extra,
});
