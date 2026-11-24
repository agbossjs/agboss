import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { IdempotencyError } from "../../core/error-families/effect-errors.js";

/**
 * The mutex of a SQLite file (#1317c). Every `Sqlite*Repository` of an application shares one
 * synchronous `DatabaseSync`, and an asynchronous `runOnce` keeps its `BEGIN IMMEDIATE` transaction
 * open across awaits — so any other statement run meanwhile would join that transaction (a plain
 * write rolled back with it, a `BEGIN IMMEDIATE` of a repository failing inside it). The mutex makes
 * that impossible: while a hold is open, every other operation waits in a queue and runs when it
 * ends — except the holder's own statements (the ones made inside the hold's async context) and
 * the priority ones of the holder's connection (a lease renewal, which a long hold must never
 * delay: its lease would expire under it).
 */

/** The async context of the open holds, one for every file: what `ambientSqliteTransaction` reads. */
const contexts = new AsyncLocalStorage<Hold>();

/** The transaction scope of the open hold the caller runs inside, on any file; `undefined` outside one. */
export function ambientHoldScope(): unknown {
  const hold = contexts.getStore();
  return hold === undefined || hold.isEnded === true ? undefined : hold.scope;
}

/** What an open hold is: the connection that owns it and the transaction scope its statements use. */
export interface Hold<TScope = unknown> {
  /** The connection whose `runOnce` holds the file. */
  readonly owner: object;
  /** Set once the hold ended: a late continuation of it is no longer inside anything, and refused. */
  isEnded?: boolean;
  /** Set once the hold's `COMMIT` succeeded: any other end rolled back, and re-applies `renewals`. */
  isCommitted?: boolean;
  /** The lease renewals served ahead inside the hold's transaction: lost with a rollback, so re-applied after it. */
  renewals?: (() => unknown)[];
  /** The transaction scope of the hold (`SqliteTransactionScope`), set once `BEGIN` ran. */
  scope?: TScope;
}

/** One waiter: an operation to start when the hold ahead of it ends. */
interface Waiter<TScope> {
  readonly isHold: boolean;
  start(): Hold<TScope> | undefined;
}

/** The mutex of one file (shared by the connections of one process that open it). */
export class SqliteMutex<TScope = unknown> {
  #active: Hold<TScope> | undefined;
  #priority = 0;
  readonly #queue: Waiter<TScope>[] = [];
  readonly #context = contexts as AsyncLocalStorage<Hold<TScope>>;

  /** The open hold, if any. */
  get active(): Hold<TScope> | undefined {
    return this.#active;
  }

  /** Whether the caller runs inside the open hold's async context: its statements are the hold's. */
  get isInside(): boolean {
    const active = this.#active;
    return active !== undefined && this.#context.getStore() === active;
  }

  /**
   * The safety net under the queue: a statement that is neither the holder's nor a priority one of
   * the holder's connection must never run while a hold is open — it would join its transaction. The
   * repositories queue their operations, so this is unreachable; if one slipped past (an `await`
   * between the queue and its statement) it fails loudly instead of corrupting a transaction.
   */
  assertMayRun(owner?: object): void {
    this.#refuseEnded();
    if (this.#active === undefined || this.#priority > 0) return;
    // another connection's statement never joins the hold's transaction (its own database, its own lock)
    if (this.isInside && this.#active.owner !== owner) return;
    if (this.isInside)
      throw new IdempotencyError.OutsideTransaction({
        message:
          "a statement ran on the raw SQLite database inside a runOnce: inside `execute` write only through requireTransaction(), whose statements roll back with the effect",
      });
    throw new Error(
      "unreachable: a statement ran on the SQLite connection while a runOnce transaction was open and it was not queued behind it — every SqliteRepository operation goes through the connection's mutex",
    );
  }

  /**
   * `work` as soon as no hold is open (at once when none is, or when the caller is the holder),
   * else after the holds ahead of it ended, in order. `work` is synchronous: its statements run
   * with no hold open.
   */
  whenFree<TValue>(work: () => TValue): TValue | Promise<Awaited<TValue>> {
    const ended = this.#endedHold();
    if (ended !== undefined) return Promise.reject(ended);
    if (this.#active === undefined || this.isInside) return work();
    return new Promise((resolveWork, rejectWork) => {
      this.#queue.push({
        isHold: false,
        start: () => {
          try {
            resolveWork(work() as Awaited<TValue>);
          } catch (error) {
            // whatever the operation threw, as it threw it
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            rejectWork(error);
          }
          return undefined;
        },
      });
    });
  }

  /**
   * `work`'s statements served ahead of the queue, inside the open hold's transaction: only for the
   * connection that owns the hold (a statement of another connection to the file would wait for the
   * write lock the hold keeps, blocking the loop that must finish it), else as `whenFree`. For a
   * single statement. A lease renewal (`isRenewal`) rides inside the hold's transaction, so a
   * rollback would take it along while its holder believes the lease moved: the hold re-applies it
   * right after the rollback, under the mutex, before anything else runs (see `hold`).
   */
  ahead<TValue>(
    owner: object,
    work: () => TValue,
    isRenewal = false,
  ): TValue | Promise<Awaited<TValue>> {
    const ended = this.#endedHold();
    if (ended !== undefined) return Promise.reject(ended);
    const active = this.#active;
    if (active?.owner !== owner) return this.whenFree(work);
    if (isRenewal) (active.renewals ??= []).push(work);
    return this.trusted(work);
  }

  /** `work` (synchronous statements) as the store's own: allowed inside the open hold, never interleaved. */
  trusted<TValue>(work: () => TValue): TValue {
    this.#priority += 1;
    try {
      return work();
    } finally {
      this.#priority -= 1;
    }
  }

  /** The refusal for a caller whose async context is a hold that already ended, else `undefined`. */
  #endedHold(): IdempotencyError.OutsideTransaction | undefined {
    if (this.#context.getStore()?.isEnded !== true) return undefined;
    return new IdempotencyError.OutsideTransaction({
      message:
        "the runOnce this code runs in is over (it ended, timed out or was rolled back): a late statement of its `execute` writes nothing",
    });
  }

  #refuseEnded(): void {
    const ended = this.#endedHold();
    if (ended !== undefined) throw ended;
  }

  /**
   * `work` as the one hold of the file: waits its turn behind the holds and operations ahead of it,
   * runs in the hold's async context (its statements are then the holder's), and ends the hold when
   * it settles, whatever way.
   */
  async hold<TValue>(
    owner: object,
    work: (hold: Hold<TScope>) => Promise<TValue>,
    onNested: () => Error,
  ): Promise<TValue> {
    if (this.isInside) throw onNested();
    const hold = await this.#acquired(owner);
    try {
      return await this.#context.run(hold, () => work(hold));
    } finally {
      hold.isEnded = true;
      this.#reapplied(hold);
      this.#active = undefined;
      this.#drain();
    }
  }

  /**
   * The renewals served inside a hold that did not commit, run again now that its transaction is
   * gone: the lease the holder renewed stays renewed. One that fails (the lease truly moved) is
   * left to the holder's next renewal, which then answers that it is lost.
   */
  #reapplied(hold: Hold<TScope>): void {
    if (hold.isCommitted === true || hold.renewals === undefined) return;
    for (const renew of hold.renewals) {
      try {
        const answered = this.trusted(renew);
        void Promise.resolve(answered).catch(() => undefined);
      } catch {
        // see above: the next renewal reports a lost lease
      }
    }
  }

  /** The hold, once it is this caller's turn. */
  #acquired(owner: object): Promise<Hold<TScope>> {
    if (this.#active === undefined && this.#queue.length === 0)
      return Promise.resolve(this.#open(owner));
    return new Promise((resolveHold) => {
      this.#queue.push({ isHold: true, start: () => this.#open(owner, resolveHold) });
    });
  }

  #open(owner: object, onOpen?: (hold: Hold<TScope>) => void): Hold<TScope> {
    const hold: Hold<TScope> = { owner };
    this.#active = hold;
    onOpen?.(hold);
    return hold;
  }

  /** Starts the waiters in order, up to the next hold (which then keeps the file). */
  #drain(): void {
    for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
      next.start();
      if (next.isHold) return;
    }
  }
}

/** The mutexes of the files open in this process, by their absolute path. */
const mutexes = new Map<string, SqliteMutex>();

/**
 * The mutex of the file at `path`: one for every connection of this process to it (two instances of
 * a test on one file queue behind each other's holds instead of blocking the loop on SQLite's write
 * lock); `:memory:` is its connection's alone.
 */
export function mutexOfSqliteFile(path: string): SqliteMutex {
  if (path === ":memory:") return new SqliteMutex();
  const key = resolve(path);
  const known = mutexes.get(key);
  if (known !== undefined) return known;
  const made = new SqliteMutex();
  mutexes.set(key, made);
  return made;
}
