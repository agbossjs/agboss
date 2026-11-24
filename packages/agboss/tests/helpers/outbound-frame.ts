import { OutboundMasking } from "../../src/app/outbound-masking.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import type { OutboundCallReport } from "../../src/app/audit-log.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { runInFrame, type FrameLease, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  Idempotency,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  OutboundRecovery,
  Reconciliation,
  type Clock,
  type OutboundCallLookup,
  type IdempotencySendOptions,
  type OutboundCallOutcome,
} from "../../src/index.js";
import { type EffectKey, type OutboundCallKey } from "../../src/stores/index.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLease,
} from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { VirtualClock } from "../../src/testing/clock.js";
import type { FakePaymentGateway } from "../../src/testing/gateway/fake-payment-gateway.js";
import { hours, seconds } from "../../src/units/index.js";
import { testFrame } from "./frame.js";
import { Logger, type LogEntry } from "../../src/infrastructure/logger.js";
import { TEST_IDEMPOTENCY_KEY } from "../../src/application/idempotency-key.js";
import { storeClockOf } from "./store-clock.js";

/**
 * #657, #658 — `Idempotency.sendOnce` in a step's frame made by hand over the in-memory stores, on a test's
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
  readonly settings?: OutboundMasking;
  readonly store?: typeof InMemoryOutboundCallRepository;
}

/**
 * What a test says of a call: `sendOnce`'s options without what the key says (`name`, `key`) —
 * `timeout` and `ttl` default to 15 s and 48 hours.
 */
export type OutboundSendCase<TRequest, TResult> = Omit<
  IdempotencySendOptions<TRequest, TResult>,
  "name" | "key" | "timeout" | "ttl"
> &
  Partial<Pick<IdempotencySendOptions<TRequest, TResult>, "timeout" | "ttl">>;

/** A taken lease and the key of a call under it. */
export interface KeyedLease {
  readonly lease: ExecutionLease;
  readonly key: EffectKey;
}

/** One instance's stores and `Idempotency`, with what its frame was told and its log. */
export interface OutboundFrame {
  /** The stores' time, and the instance's unless `instanceClock` skews it. */
  readonly clock: VirtualClock;
  readonly store: InMemoryOutboundCallRepository;
  readonly leases: InMemoryExecutionLeaseRepository;
  readonly reports: OutboundCallReport[];
  readonly logger: { readonly entries: LogEntry[] };
  readonly keyIn: (executionId: string, businessKey?: string) => Promise<KeyedLease>;
  /** The effects store beside it. */
  readonly effects: InMemoryFencedEffectRepository;
  /** The instance's service, and a second instance over the same stores (a takeover's). */
  readonly idempotency: Idempotency;
  readonly otherInstance: () => Idempotency;
  /** `work` in the frame of the step `key` was made under. */
  readonly inFrame: <TValue>(key: EffectKey, work: () => Promise<TValue>) => Promise<TValue>;
  /** `sendOnce` of the execution `key` was made under, in a frame of its lease. */
  readonly send: <TRequest, TResult>(
    key: EffectKey,
    callOptions: OutboundSendCase<TRequest, TResult>,
  ) => Promise<OutboundCallOutcome<TResult>>;
}

/** The stores of one instance, its `Idempotency`, and a step's frame that keeps what it is told. */
export function outboundFrame(options: OutboundFrameOptions = {}): OutboundFrame {
  const clock = new VirtualClock();
  const database = new InMemoryDatabase();
  const application = applicationContextOf({
    ...{ name: "outbound-application", version: "1.0.0", instanceId: "instance-1" },
    ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
  });
  const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), application, database);
  const Store = options.store ?? InMemoryOutboundCallRepository;
  const store = new Store(storeClockOf(clock), database, leases);
  const reports: OutboundCallReport[] = [];
  const base = testFrame();
  const logger = new KeptLogger();
  const settings = options.settings ?? new OutboundMasking({ requiresMask: false });
  const instanceClock = options.instanceClock?.(clock) ?? clock;
  const effects = new InMemoryFencedEffectRepository(storeClockOf(clock), database, leases);
  const idempotency = new Idempotency(effects, store, settings, logger, instanceClock);
  const origin = { executionId: base.execution.executionId, nodeId: "pay-action", visitNumber: 1 };
  /** The frame of the step `key` was made under: the lease it names, its step. */
  const frameOf = (key: EffectKey): FrameSpec => {
    const lease: FrameLease = {
      tenantId: key.tenantId,
      leaseExecutionId: key.leaseExecutionId,
      scopeKey: key.scopeKey,
      token: key.token,
      trustedUntil: Number.POSITIVE_INFINITY,
      isYielded: false,
      assertHeld: () => undefined,
      renewNow: () => Promise.resolve(),
      enterStep: () => Promise.resolve(() => undefined),
      recordOutboundCall: (report) => {
        reports.push(report);
      },
    };
    // an application's frame carries its idempotency keys (#825): a business key's fingerprint
    const fingerprintKeys = { current: TEST_IDEMPOTENCY_KEY };
    return {
      ...base,
      execution: { ...base.execution, lease, fingerprintKeys },
      step: { ...base.step, idempotencyKey: key.idempotencyKey },
    };
  };
  /** The lease of `executionId` taken, and the call's key under it — `order:42` by default. */
  const keyIn = async (executionId: string, businessKey = "order:42"): Promise<KeyedLease> => {
    const taken = await leases.acquire("default", executionId, LONG_LEASE);
    if (taken === undefined) throw new Error(`the lease of ${executionId} is held`);
    return { lease: taken, key: effectKeyForTesting(keyOf(taken), { origin, businessKey }) };
  };
  /** `idempotency.sendOnce` in the frame of `key`'s step. */
  const send = <TRequest, TResult>(
    key: EffectKey,
    callOptions: OutboundSendCase<TRequest, TResult>,
  ): Promise<OutboundCallOutcome<TResult>> =>
    runInFrame(frameOf(key), () =>
      idempotency.sendOnce({
        timeout: seconds(15),
        ttl: hours(48),
        ...callOptions,
        name: key.name,
        ...(key.businessKey === undefined ? {} : { key: key.businessKey }),
      }),
    );
  const otherInstance = (): Idempotency =>
    new Idempotency(effects, store, settings, new KeptLogger(), instanceClock);
  const inFrame = <TValue>(key: EffectKey, work: () => Promise<TValue>): Promise<TValue> =>
    runInFrame(frameOf(key), work);
  return {
    ...{ clock, store, leases, reports, logger, keyIn, send, effects },
    ...{ idempotency, otherInstance, inFrame },
  };
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
 * A lookup by a reference that does not expire: the gateway's own record of every payment it
 * made (its books), not its key store — as a lookup by the merchant reference is.
 */
export const byReference =
  (gateway: FakePaymentGateway) =>
  (lookup: OutboundCallLookup): Reconciliation<GatewayPaymentReceipt> => {
    const found = gateway.payments.find(
      (payment) => payment.idempotencyKey === lookup.idempotencyKey,
    );
    return found === undefined
      ? Reconciliation.notExecuted()
      : Reconciliation.completed({ paymentId: found.paymentId });
  };

/** A charge of 10 at `gateway`, reconciled by reference, with `extra` options over it. */
export const gatewayCharge = (
  gateway: FakePaymentGateway,
  extra: Partial<OutboundSendCase<GatewayChargeRequest, GatewayPaymentReceipt>> = {},
): OutboundSendCase<GatewayChargeRequest, GatewayPaymentReceipt> => ({
  target: "gateway",
  operation: "charge",
  request: { amount: 10 },
  send: async (call) => {
    const receipt = await gateway.charge({ amount: 10, idempotencyKey: call.idempotencyKey });
    return { paymentId: receipt.paymentId };
  },
  recovery: OutboundRecovery.permanentLookup(byReference(gateway)),
  ...extra,
});

/**
 * `key` as a test reads the store by it (#825): the store is asked under a business key only with a
 * fingerprint — `send` gives it the request's — and a lookup by the business key ignores which.
 */
export const lookupKeyOf = (key: EffectKey | OutboundCallKey): EffectKey =>
  key.businessKey === undefined || key.fingerprint !== undefined
    ? (key as EffectKey)
    : effectKeyForTesting(key, { fingerprint: "a lookup" });
