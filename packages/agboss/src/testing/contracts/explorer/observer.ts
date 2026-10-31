import { EXPLORED_LEASE, ExplorerInvariant, type ExplorerViolation } from "./types.js";

/**
 * What the explorer knows of the world it schedules (#533 item 1): each tree's lease as the
 * contract says the store must hold it, after the answers the store gave — its epoch, holder, end
 * and whether it was released, finished or closed by a check — and each instance's belief, the
 * window its holder trusts its lease (from when it sent the request, for the time the store said
 * was left). The invariants are checked against these after every step.
 */

/** A tree's lease as the contract says it stands. */
export interface TreeTruth {
  epoch: number;
  holder: number;
  /** When it ends, on the store's time (the run's clock): its last take or renewal + the lease. */
  expiresAt: number;
  released: boolean;
  finished: boolean;
  superseded: boolean;
}

/** What one instance believes of one tree's lease. */
export interface Belief {
  readonly epoch: number;
  /** Trusted while the time is before this (sent at + remaining). */
  until: number;
  yielded: boolean;
}

/** The observer's state: truths, beliefs, the last token each instance held, the charges. */
export class Observer {
  readonly trees = new Map<string, TreeTruth>();
  readonly beliefs = new Map<string, Belief>();
  readonly tokens = new Map<string, number>();
  readonly granted = new Map<string, Set<number>>();
  readonly charges = new Map<string, number>();
  readonly violations: ExplorerViolation[] = [];

  /** The belief of `instance` on `tree`, if it holds one. */
  beliefOf(instance: number, tree: string): Belief | undefined {
    return this.beliefs.get(slotOf(instance, tree));
  }

  /** The last token `instance` held on `tree` (a zombie writes at it). */
  tokenOf(instance: number, tree: string): number | undefined {
    return this.tokens.get(slotOf(instance, tree));
  }

  /** Whether `instance` trusts its lease of `tree` at `now`. */
  isTrusting(instance: number, tree: string, now: number): boolean {
    const belief = this.beliefOf(instance, tree);
    return belief !== undefined && now < belief.until;
  }

  /** `instance` was granted `epoch` of `tree` at `now`, `remaining` left (acquire, reclaim). */
  grant(instance: number, tree: string, epoch: number, remaining: number, now: number): void {
    const truth = this.trees.get(tree);
    if (truth?.finished === true)
      this.fail(
        ExplorerInvariant.NoTakeoverOfFinishedWork,
        `${tree} was finished at epoch ${String(truth.epoch)}, and instance-${String(instance)} was granted epoch ${String(epoch)}: a takeover of finished work`,
      );
    const epochs = this.granted.get(tree) ?? new Set<number>();
    if (epochs.has(epoch))
      this.fail(
        ExplorerInvariant.OneLiveHolder,
        `epoch ${String(epoch)} of ${tree} was granted twice (again to instance-${String(instance)})`,
      );
    epochs.add(epoch);
    this.granted.set(tree, epochs);
    this.#othersTrusting(instance, tree, now, `was granted epoch ${String(epoch)}`);
    this.trees.set(tree, {
      ...{ epoch, holder: instance, expiresAt: now + EXPLORED_LEASE },
      ...{ released: false, finished: false, superseded: false },
    });
    this.#trust(instance, tree, epoch, now + boundedOf(remaining));
  }

  /** `instance`'s lease of `tree` was renewed at `now` with `remaining` left. */
  renewed(instance: number, tree: string, remaining: number, now: number): void {
    const belief = this.beliefOf(instance, tree);
    if (belief === undefined) return;
    this.#othersTrusting(instance, tree, now, `renewed epoch ${String(belief.epoch)}`);
    const truth = this.trees.get(tree);
    if (truth?.epoch === belief.epoch) truth.expiresAt = now + EXPLORED_LEASE;
    belief.until = Math.max(belief.until, now + boundedOf(remaining));
  }

  /** `instance` stopped trusting its lease of `tree` (refused, released, finished). */
  ended(instance: number, tree: string): void {
    this.beliefs.delete(slotOf(instance, tree));
  }

  /** `instance` released (or finished) its lease of `tree`: the store matches its own lease only. */
  released(instance: number, tree: string, epoch: number, isFinished: boolean): void {
    this.ended(instance, tree);
    const truth = this.trees.get(tree);
    if (truth?.epoch !== epoch || truth.holder !== instance) return;
    truth.released = true;
    if (isFinished) truth.finished = true;
  }

  /** A check closed `tree`'s lease at `epoch` (`Superseded`). */
  superseded(tree: string, epoch: number): void {
    const truth = this.trees.get(tree);
    if (truth?.epoch !== epoch) return;
    truth.released = true;
    truth.superseded = true;
  }

  /**
   * The store accepted `what` at `token` of `tree` at `now`: a violation unless `token` is the
   * tree's current epoch, not released, finished or closed, and not expired.
   */
  accepted(what: string, tree: string, token: number, now: number): void {
    const problem = staleProblemOf(this.trees.get(tree), token, now);
    if (problem !== undefined)
      this.fail(
        ExplorerInvariant.NoStaleWrite,
        `${what} at token ${String(token)} of ${tree} was accepted, but ${problem}`,
      );
  }

  /** The other system charged `businessKey` once more. */
  charged(businessKey: string, by: string): void {
    const count = (this.charges.get(businessKey) ?? 0) + 1;
    this.charges.set(businessKey, count);
    if (count > 1)
      this.fail(
        ExplorerInvariant.OneSendPerBusinessKey,
        `${businessKey} was charged ${String(count)} times (the last by ${by})`,
      );
  }

  fail(invariant: ExplorerInvariant, message: string): void {
    this.violations.push({ invariant, message });
  }

  /** A canonical text of the state, times relative to `now`: what the search remembers. */
  keyOf(now: number): string {
    const relative = (at: number): number => Math.max(-1, at - now);
    const trees = [...this.trees].map(([tree, truth]) => [
      tree,
      { ...truth, expiresAt: relative(truth.expiresAt) },
    ]);
    const beliefs = [...this.beliefs].map(([slot, belief]) => [
      slot,
      { ...belief, until: relative(belief.until) },
    ]);
    return JSON.stringify([trees, beliefs, [...this.tokens], [...this.charges]]);
  }

  #trust(instance: number, tree: string, epoch: number, until: number): void {
    this.beliefs.set(slotOf(instance, tree), { epoch, until, yielded: false });
    this.tokens.set(slotOf(instance, tree), epoch);
  }

  /** Another instance still trusts its lease of `tree` while `instance` `did` at `now`. */
  #othersTrusting(instance: number, tree: string, now: number, did: string): void {
    for (const [slot, belief] of this.beliefs) {
      const [other, otherTree] = partsOf(slot);
      if (other === instance || otherTree !== tree || now >= belief.until) continue;
      this.fail(
        ExplorerInvariant.OneLiveHolder,
        `instance-${String(instance)} ${did} of ${tree} while instance-${String(other)} still trusts epoch ${String(belief.epoch)} for ${String(belief.until - now)} ms: two live holders`,
      );
    }
  }
}

/** The key of one instance's view of one tree. */
const slotOf = (instance: number, tree: string): string => `${String(instance)}|${tree}`;

const partsOf = (slot: string): readonly [number, string] => {
  const [instance = "0", tree = ""] = slot.split("|");
  return [Number(instance), tree];
};

/** What a holder trusts of an answered `remaining`: never more than the lease (#533 fails closed). */
const boundedOf = (remaining: number): number =>
  Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, EXPLORED_LEASE) : 0;

/** Why `token` may not write `tree` at `now`; `undefined` when it may. */
function staleProblemOf(
  truth: TreeTruth | undefined,
  token: number,
  now: number,
): string | undefined {
  if (truth === undefined) return "no lease of it was ever granted";
  if (token < truth.epoch) return `epoch ${String(truth.epoch)} superseded it`;
  if (token > truth.epoch) return `epoch ${String(token)} was never granted`;
  if (truth.finished) return "its lease was finished";
  if (truth.superseded) return "a check closed its lease (Superseded)";
  if (truth.released) return "its lease was released";
  if (now >= truth.expiresAt) return `its lease ended ${String(now - truth.expiresAt)} ms before`;
  return undefined;
}
