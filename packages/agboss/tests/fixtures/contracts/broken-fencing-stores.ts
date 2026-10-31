/**
 * Deliberately broken fencing stores (#526 AC3, AC6): each gets one thing wrong the way a port to
 * another database does, and `storeConformance` must catch it — a fenced effect whose lease check
 * and write are two steps (check, then write), one whose business rows land outside its
 * transaction, a `leaseStateOf` that reads, then closes in a second step, a lease log on the row
 * schema of before #508, and stores that declare no backend or another one than their leases'.
 * The `fencing-*.contract-fixture.ts` files run a store set with one of them.
 */
import {
  ExecutionLeaseEventKind,
  InMemoryExecutionLeaseEventRepository,
  OutboundCallEventOutcome,
  OutboundCallLeaseState,
  type ExecutionLeaseEventRecord,
} from "../../../src/infrastructure/execution-lease-event.repository.js";
import {
  InMemoryExecutionLeaseRepository,
  LeaseCheck,
} from "../../../src/infrastructure/execution-lease.repository.js";
import {
  fencedKeyIdentityOf,
  replayedFromOf,
  storedKeyFactsOf,
} from "../../../src/infrastructure/fenced-effect-key.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  FencedEffectRepository,
  FencedEffectStatus,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "../../../src/infrastructure/fenced-effect.repository.js";
import { treeKeyOf } from "../../../src/infrastructure/in-memory-database.js";
import {
  checkInMemoryFence,
  InMemoryFencedEffectRepository,
  raiseInMemoryMark,
} from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import {
  InMemoryOutboundCallRepository,
  type OutboundCallLease,
} from "../../../src/infrastructure/outbound-call.repository.js";
import type {
  FencedEffectStores,
  OutboundCallStores,
} from "../../../src/testing/contracts/index.js";
import {
  sharedInMemory,
  type InstanceSeam,
  type StoreFactory,
} from "../../infrastructure/contracts/store-kinds.js";

/** One real millisecond: the gap a network round trip leaves between a read and a write. */
const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 1));

/** A broken store's transaction: its business rows, applied at its commit or at once. */
export class BufferedTransaction {
  readonly writes: (() => void)[] = [];

  constructor(private readonly isImmediate: boolean) {}

  onCommit(write: () => void): void {
    if (this.isImmediate) write();
    else this.writes.push(write);
  }
}

interface StoredResult {
  readonly token: number;
  readonly storedAt: number;
  readonly result: string;
  readonly fingerprint?: string;
  readonly origin?: unknown;
}

/** What both broken effect stores share: the seam, the results of the test, the replay. */
abstract class BrokenEffects extends FencedEffectRepository<BufferedTransaction> {
  static override readonly backend: string | undefined = "in-memory";

  constructor(
    protected readonly seam: InstanceSeam,
    protected readonly results: Map<string, StoredResult>,
  ) {
    super(new FencedEffectSettings());
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    for (const [row, stored] of this.results)
      if (stored.storedAt < cutoff.getTime()) this.results.delete(row);
    return Promise.resolve();
  }

  /** The stored result of `key`, replayed. */
  protected replayOf<TResult>(
    key: FencedEffectKey,
    stored: StoredResult,
  ): FencedEffectOutcome<TResult> {
    const replayedFrom = replayedFromOf(key, stored);
    return {
      status: FencedEffectStatus.Replayed,
      result: JSON.parse(stored.result) as TResult,
      token: stored.token,
      ...(replayedFrom === undefined ? {} : { replayedFrom }),
    };
  }

  /** Stores `key`'s result: Ran. */
  protected stored<TResult>(key: FencedEffectKey, result: unknown): FencedEffectOutcome<TResult> {
    const text = this.storedResultOf(key, result);
    this.results.set(fencedKeyIdentityOf(key), {
      token: key.token,
      storedAt: this.seam.clock.now().getTime(),
      result: text,
      ...storedKeyFactsOf(key),
    });
    return {
      status: FencedEffectStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }

  protected check(key: FencedEffectKey): void {
    checkInMemoryFence(this.seam.database, this.seam.clock, key);
    raiseInMemoryMark(this.seam.database, this.seam.clock, key);
  }
}

/**
 * Check, then write: the lease and the key are read, a round trip passes, then the work runs and
 * its rows and result are written — nothing re-checked, nothing locked. A takeover in the gap and
 * the new holder's write of the same key both land: a double charge.
 */
export class CheckThenWriteEffects extends BrokenEffects {
  protected async runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<BufferedTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    this.check(key);
    const found = this.results.get(fencedKeyIdentityOf(key));
    await roundTrip();
    if (found !== undefined) return this.replayOf(key, found);
    const transaction = new BufferedTransaction(false);
    const outcome = this.stored<TResult>(key, await work(transaction));
    for (const write of transaction.writes) write();
    return outcome;
  }
}

/**
 * The business rows outside the transaction: each lands as the work writes it, before the lease
 * is checked again — refused or thrown, the row stays.
 */
export class RowsOutsideEffects extends BrokenEffects {
  protected async runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<BufferedTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    this.check(key);
    const found = this.results.get(fencedKeyIdentityOf(key));
    if (found !== undefined) return this.replayOf(key, found);
    const result = await work(new BufferedTransaction(true));
    await roundTrip();
    this.check(key);
    return this.stored<TResult>(key, result);
  }
}

/** The fenced-effect stores of `Effects` over the test's database, rows applied by its transaction. */
export const brokenEffects =
  (
    Effects: new (seam: InstanceSeam, results: Map<string, StoredResult>) => BrokenEffects,
  ): StoreFactory<FencedEffectStores<BufferedTransaction>> =>
  (seam) => {
    const committed = sharedInMemory(seam, "broken-rows", (): string[] => []);
    return {
      effects: new Effects(
        seam,
        sharedInMemory(seam, "broken-results", () => new Map()),
      ),
      leases: new InMemoryExecutionLeaseRepository(seam.clock, seam.application, seam.database),
      rows: {
        insert: (transaction, row) => {
          transaction.onCommit(() => committed.push(row));
        },
        committed: () => Promise.resolve([...committed]),
      },
    };
  };

/** `leaseStateOf` as a SELECT, a round trip, then the close: a renewal between them is missed. */
class SelectThenCloseCalls extends InMemoryOutboundCallRepository {
  constructor(private readonly seam: InstanceSeam) {
    const leases = new InMemoryExecutionLeaseRepository(
      seam.clock,
      seam.application,
      seam.database,
    );
    super(seam.clock, seam.database, leases);
  }

  override async leaseStateOf({ tenantId, leaseExecutionId, token }: OutboundCallLease) {
    const rows = this.seam.database.executionLeases;
    const key = treeKeyOf(tenantId, leaseExecutionId);
    const read = rows.get(key);
    if (read === undefined || read.released || read.lease.leaseEpoch !== token)
      return OutboundCallLeaseState.Ended;
    if (read.lease.expiresAt > this.seam.clock.now()) return OutboundCallLeaseState.Live;
    await roundTrip();
    const row = rows.get(key);
    if (row !== undefined) rows.set(key, { ...row, released: true, isSuperseded: true });
    return OutboundCallLeaseState.Superseded;
  }
}

export const selectThenCloseCalls: StoreFactory<OutboundCallStores> = (seam) => ({
  calls: new SelectThenCloseCalls(seam),
  leases: new InMemoryExecutionLeaseRepository(seam.clock, seam.application, seam.database),
});

/** The #508 fields the row schema before it has no column for. */
const LOST = new Set(["supersededBy", "supersededLease", "replayedFrom"]);

/** The outcomes of the lease log's row schema before #508. */
const OLD_OUTCOMES = new Set<string>([
  OutboundCallEventOutcome.Recorded,
  OutboundCallEventOutcome.Sent,
  OutboundCallEventOutcome.Replayed,
  OutboundCallEventOutcome.Reconciled,
  OutboundCallEventOutcome.NotSent,
  OutboundCallEventOutcome.Unknown,
  OutboundCallEventOutcome.Failed,
  OutboundCallEventOutcome.Joined,
]);

/**
 * A lease log on the row schema of before #508, as agbossjs/postgres's was: the #508 outcomes are
 * refused (a CHECK of its column), its fields have no column and are lost.
 */
export class PreSupersedeLeaseLog extends InMemoryExecutionLeaseEventRepository {
  override save(record: ExecutionLeaseEventRecord): Promise<void> {
    if (record.kind === ExecutionLeaseEventKind.OutboundCall && !OLD_OUTCOMES.has(record.outcome))
      return Promise.reject(
        new Error(`new row violates check constraint "outcome": ${record.outcome}`),
      );
    // the record as its schema keeps it: less the fields it has no column for
    const kept = JSON.stringify(record, (field, value: unknown) =>
      LOST.has(field) ? undefined : value,
    );
    return super.save(JSON.parse(kept) as ExecutionLeaseEventRecord);
  }
}

/** A fenced-effect store on another backend than the leases it checks. */
export class ElsewhereEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "redis";
}

/** An outbound-call store that declares no backend. */
export class UndeclaredCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = undefined;
}

/** An outbound-call store that opts out of the atomic lease check: not compared. */
export class UncheckedCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = "redis";
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}

/** A lease store that declares no backend. */
export class UndeclaredLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = undefined;
}
