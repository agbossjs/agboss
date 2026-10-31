import type { Clock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";
import type { ExecutionLease } from "../infrastructure/execution-lease.repository.js";
import type { LeaseEventLog } from "./execution-leases.js";
import type * as LeaseEvents from "./lease-events.js";
import type { HandOverReport } from "./lease-events.js";
/**
 * When a held lease is yielded (#333 PR 4, #471): while every caller of the tree waits for remote
 * children (`yieldWhile`) and no step of the tree runs — a sibling branch's step keeps the lease, and
 * a step that starts while it is yielded takes it back first. The yields and re-acquires run one at a
 * time, in order; `move(shouldYield)` does one.
 */
export class LeaseYields {
  /** The callers waiting for remote children in `yieldWhile`. */
  #waiting = 0;
  /** The steps of the tree running under the lease. */
  #running = 0;
  #moves: Promise<void> = Promise.resolve();

  constructor(private readonly move: (shouldYield: boolean) => Promise<void>) {}

  /** A step starts: the lease held (taken back first when it was yielded); the function leaves. */
  async enterStep(): Promise<() => void> {
    this.#running += 1;
    try {
      await this.settle();
    } catch (error) {
      this.#running -= 1;
      throw error;
    }
    let isLeft = false;
    return (): void => {
      if (isLeft) return;
      isLeft = true;
      this.#running -= 1;
      void this.settle().catch((): undefined => undefined);
    };
  }

  /** A caller waits for remote children: the lease yielded once nothing else holds it. */
  async startWaiting(): Promise<void> {
    this.#waiting += 1;
    await Promise.resolve();
    await this.settle();
  }

  /** The caller stopped waiting: with `isHandedOver` false, the lease taken back before it goes on. */
  async stopWaiting(isHandedOver: boolean): Promise<void> {
    this.#waiting -= 1;
    if (!isHandedOver) await this.settle();
  }

  /** The next move: yield when every caller waits and no step runs, else hold. */
  settle(): Promise<void> {
    const next = this.#moves.then(() => this.move(this.#waiting > 0 && this.#running === 0));
    this.#moves = next.catch((): undefined => undefined);
    return next;
  }
}

/**
 * One renewal or reclaim of a held lease at a time (#516): a renewal reads the lease when its turn
 * comes, so it never answers for a token a reclaim moved on meanwhile (which would read as lost).
 */
export class LeaseTurns {
  #turns: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#turns.then(work);
    this.#turns = turn.catch((): undefined => undefined);
    return turn;
  }
}

/**
 * The outbound calls' attempts in flight under a lease (#508): its holder releases it only once
 * they settled — renewed on meanwhile — so no other instance takes a pending intent for gone while
 * its owner still sends. The wait is bounded: by each attempt's `attemptTimeout`, by the instance's
 * stop and by a lost lease; past a bound the holder stops renewing without releasing, and the lease
 * expires — only a takeover then lets another instance reconcile.
 */
export class LeaseAttempts {
  /** Each attempt kept, settled either way, with the `Clock` time its wait ends. */
  readonly #attempts = new Map<Promise<void>, number>();

  constructor(private readonly clock: Clock) {}

  /**
   * Keeps `attempt` for at most `maxWait` from now, entered as a step while it runs (`enterStep`) —
   * up to the same bound: a lease is never yielded under an attempt in flight within its
   * `attemptTimeout`, as under a running step; past it, a hung attempt holds no yield back.
   */
  keep(
    attempt: Promise<unknown>,
    maxWait: Milliseconds,
    enterStep: () => Promise<() => void>,
  ): void {
    const settled = attempt.then(
      () => undefined,
      () => undefined,
    );
    // a step for the lease's yields until it settled or its bound passed (then a reclaim may move
    // its token on: what it answers late is fenced, and other executions reconcile its intent)
    const bounded = new AbortController();
    void settled.then(() => {
      bounded.abort();
    });
    const held = Promise.race([settled, this.clock.sleep(maxWait, bounded.signal)]);
    void enterStep().then(
      (leave) => held.then(leave),
      () => undefined,
    );
    this.#attempts.set(settled, this.clock.now().getTime() + maxWait);
    void settled.then(() => {
      this.#attempts.delete(settled);
    });
  }

  /** Whether every attempt kept settled before a bound — `lost`, `stopping`, the timeouts — ended the wait. */
  async settled(lost: AbortSignal, stopping?: AbortSignal): Promise<boolean> {
    if (this.#attempts.size === 0) return true;
    const done = new AbortController();
    const ended = AbortSignal.any([
      lost,
      done.signal,
      ...(stopping === undefined ? [] : [stopping]),
    ]);
    const until = Math.max(...this.#attempts.values()) - this.clock.now().getTime();
    try {
      await Promise.race([
        Promise.all([...this.#attempts.keys()]),
        this.clock.sleep(Math.max(0, until) as Milliseconds, ended),
      ]);
    } finally {
      // no listener or timer outlives the wait
      done.abort();
    }
    return this.#attempts.size === 0;
  }
}

/**
 * The lease events a held lease records (#501): its hand-overs and its steps' fenced effects, each
 * written through the instance's lease log in the order recorded — a refused effect before the
 * hand-over it causes — and the lease released only once they were, so the moving call rejects
 * after its rows exist.
 */
export class LeaseEventReports {
  #tail: Promise<void> = Promise.resolve();
  #holder: Pick<ExecutionLease, "holderInstanceId" | "leaseEpoch"> | undefined;

  /** The lease now held: its holder and token name a later hand-over. */
  held(lease: ExecutionLease): void {
    this.#holder = lease;
  }

  handOver(events: LeaseEventLog | undefined, report: HandOverReport, scopeKey: string): void {
    const holder = this.#holder;
    if (holder === undefined) return;
    const lease = { scopeKey, holderInstanceId: holder.holderInstanceId, token: holder.leaseEpoch };
    this.#append(events, (recording, log) => recording.recordHandOver(log, report, lease));
  }

  /**
   * A call a step under the lease made — a fenced effect's (#501) or one that leaves the system
   * (#505): `write` records it with the holder's instance, in the lease's order.
   */
  stepCall(
    events: LeaseEventLog | undefined,
    write: (recording: typeof LeaseEvents, log: LeaseEventLog, holder: string) => Promise<void>,
  ): void {
    const holderInstanceId = this.#holder?.holderInstanceId;
    if (holderInstanceId === undefined) return;
    this.#append(events, (recording, log) => write(recording, log, holderInstanceId));
  }

  /** Once every event recorded so far is written (recording never rejects). */
  settled(): Promise<void> {
    return this.#tail;
  }

  #append(
    events: LeaseEventLog | undefined,
    write: (recording: typeof LeaseEvents, log: LeaseEventLog) => Promise<void>,
  ): void {
    if (events === undefined) return;
    this.#tail = this.#tail.then(async () => write(await events.recording, events));
  }
}
