import type { ExecutionObserver } from "../core/observer-hooks.js";
import type { Class } from "../components/injection.js";
import type { Clock, IdGenerator, StoreClock } from "../infrastructure/clock.js";
import type { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import type { FingerprintKeys } from "../infrastructure/fenced-effect-key.js";
import type { ExecutionLeaseGate } from "./lease-gate.js";
import type { ForkLauncher } from "../app/remote/isolated-supervisor.js";

/**
 * What a test gives an application instance beyond `createApp`'s options (never in production):
 * the instances an earlier app of the test created (its stores: a paused execution survives
 * `recoverApp()`), this instance's id, the in-memory rows its instances share, its ids (#313: unless
 * the application lists an `IdGenerator`) and its `VirtualClock` — always, whatever `Clock` the
 * application lists: tests never run on real time. In production the listed ones, else built-in.
 */
export interface InstanceSeams {
  readonly reused?: ReadonlyMap<Class, unknown>;
  readonly instanceId?: string;
  readonly database?: InMemoryDatabase;
  readonly clock?: Clock;
  /** The stores' time (#533, `testWith`: the test's clock, unskewed); absent = the database's. */
  readonly storeClock?: StoreClock;
  readonly idGenerator?: IdGenerator;
  /** A test's instance: an unlisted `Logger` is silent, and the start is not logged. */
  readonly quiet?: boolean;
  /**
   * The PII key when the application sets none (`testWith`: a fixed one shared by its instances,
   * #334); absent = a key of the instance, one per root execution — what production does.
   */
  readonly piiTestKey?: string;
  /** `testWith(…, withInstancePiiKeys)` (#334): tokens on a key of each instance, never a failed start. */
  readonly piiInstanceKeys?: boolean;
  /** The idempotency keys of a key field with no value (#825, `testWith`); absent = the start fails. */
  readonly idempotencyTestKeys?: FingerprintKeys;
  /** Observers of the instance besides the application's (a test's call recorder, #262). */
  readonly observers?: readonly ExecutionObserver[];
  /**
   * An isolated worker's fork (#1286b, `isolated-fork-main.ts`): the instance claims the one child
   * it was started for and runs only that — no recovery sweep, no pause timers, no general claim, no
   * supervisor. `onEnded` is called once, when the child's pass ended or there was nothing to claim.
   */
  readonly isolatedChild?: {
    readonly tenantId: string;
    readonly executionId: string;
    readonly onEnded: () => void;
  };
  /** Starts the process of an isolated child (#1286b): a test's recorder; absent = a child process. */
  readonly isolatedLauncher?: ForkLauncher;
  /** A test's gate over the instance's lease (#471, `leases.freeze`): its store and its timers. */
  readonly leaseGate?: ExecutionLeaseGate;
}
