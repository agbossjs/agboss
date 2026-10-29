import type { ExecutionLeaseGate } from "../application/lease-gate.js";
import {
  ExecutionLeaseRepository,
  type ExecutionLease,
} from "../infrastructure/execution-lease.repository.js";
import { Clock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";
import { TestSetupError } from "./errors.js";

/**
 * A frozen process, in a test (#471): `leases.stall(app)` stops that instance's lease — its store
 * calls (taking, renewing, releasing, whatever `ExecutionLeaseRepository` the application lists) and
 * its lease timers (the background renewal and the local expiry, on the test's shared
 * `VirtualClock`) — while its step code keeps running, as a process under `SIGSTOP` that is not
 * scheduled; `leases.resume(app)` lets them go, the timers held meanwhile firing at once, as after
 * `SIGCONT`. With `clock.advance(seconds(31))` in between another instance takes the lease, so the
 * stalled one's next write meets a newer token (`executionContext.fence`).
 */
export interface TestLeases {
  /** Stops the lease store calls and the lease timers of `app`'s instance until `resume(app)`. */
  stall(app: object): void;
  /** Lets `app`'s instance's lease go on: what waited runs now. */
  resume(app: object): void;
}

/** One instance's gate: open, or closed until `open()`. */
export class LeaseGate implements ExecutionLeaseGate {
  #closed: { readonly opened: Promise<void>; readonly open: () => void } | undefined;

  get isClosed(): boolean {
    return this.#closed !== undefined;
  }

  close(): void {
    if (this.#closed !== undefined) return;
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.#closed = { opened, open };
  }

  open(): void {
    const closed = this.#closed;
    this.#closed = undefined;
    closed?.open();
  }

  /** Resolves once the gate is open (at once when it is); `signal` ends the wait. */
  async passed(signal?: AbortSignal): Promise<void> {
    while (this.#closed !== undefined && signal?.aborted !== true) {
      const { opened } = this.#closed;
      await (signal === undefined ? opened : Promise.race([opened, abortOf(signal)]));
    }
  }

  repositoryOf(repository: ExecutionLeaseRepository): ExecutionLeaseRepository {
    return new GatedExecutionLeaseRepository(repository, this);
  }

  clockOf(clock: Clock): Clock {
    return new GatedClock(clock, this);
  }
}

const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });

/** The instance's lease store behind its gate: every call waits while the instance is stalled. */
class GatedExecutionLeaseRepository extends ExecutionLeaseRepository {
  constructor(
    private readonly repository: ExecutionLeaseRepository,
    private readonly gate: LeaseGate,
  ) {
    super();
  }

  async ping(): Promise<void> {
    await this.gate.passed();
    return this.repository.ping();
  }

  async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    await this.gate.passed();
    return this.repository.acquire(tenantId, rootExecutionId, lease);
  }

  async renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    await this.gate.passed();
    return this.repository.renew(executionLease, lease);
  }

  async release(executionLease: ExecutionLease): Promise<void> {
    await this.gate.passed();
    return this.repository.release(executionLease);
  }
}

/** The clock the instance's lease timers sleep on: a sleep that ends while stalled waits for resume. */
class GatedClock extends Clock {
  constructor(
    private readonly clock: Clock,
    private readonly gate: LeaseGate,
  ) {
    super();
  }

  now(): Date {
    return this.clock.now();
  }

  async sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    await this.clock.sleep(delay, signal);
    await this.gate.passed(signal);
  }
}

/** The gates of a test's instances, by their app. */
const gates = new WeakMap<object, LeaseGate>();

/**
 * The `leases` fixture of a test: its stalled instances resumed at its end — and before the
 * environment closes its apps, which a stalled instance would keep waiting for its lease store.
 */
export async function withTestLeases(
  environment: { onClose: (work: () => void) => void },
  use: (leases: TestLeases) => Promise<void>,
): Promise<void> {
  const { leases, end } = testLeasesOf();
  environment.onClose(end);
  try {
    await use(leases);
  } finally {
    end();
  }
}

/** Keeps a test app's gate (made with it), for `leases.stall(app)`. */
export function rememberLeaseGate(app: object, gate: LeaseGate): void {
  gates.set(app, gate);
}

const gateOf = (app: object, call: string): LeaseGate => {
  const gate = gates.get(app);
  if (gate === undefined)
    throw new TestSetupError(`leases.${call}(app): not an app of this test (use app or apps[i])`);
  return gate;
};

/**
 * The `leases` fixture of one test, and its end: every instance it stalled resumed, so the test's
 * apps close (a stalled instance would wait for its lease store forever).
 */
export function testLeasesOf(): { readonly leases: TestLeases; readonly end: () => void } {
  const stalled = new Set<LeaseGate>();
  const leases: TestLeases = Object.freeze({
    stall: (app: object): void => {
      const gate = gateOf(app, "stall");
      stalled.add(gate);
      gate.close();
    },
    resume: (app: object): void => {
      const gate = gateOf(app, "resume");
      stalled.delete(gate);
      gate.open();
    },
  });
  const end = (): void => {
    for (const gate of stalled) gate.open();
    stalled.clear();
  };
  return { leases, end };
}
