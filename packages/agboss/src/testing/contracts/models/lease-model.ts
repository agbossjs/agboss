/**
 * The sequential model of the fencing stores (#533 items 2 and 5): what the lease contract says one
 * store does, one operation at a time — `acquire`, `renew`, `release`, `finish`, `yield`, `reclaim`,
 * `leaseStateOf` — and the fence every write and fenced read passes first (the key's lease at its
 * token, live, not released, and the scope's high-water mark). A state is plain data, never
 * changed in place: each step gives a new one, so a search may keep any state it reached. The
 * property tests check the core's stores against it; the linearizability checker checks recorded
 * histories against it.
 */

/** One tree's lease as the contract holds it. */
export interface ModelLease {
  readonly epoch: number;
  readonly holder: string;
  /** The store's time (ms) it ends at: its last take or renewal plus the lease asked for. */
  readonly expiresAt: number;
  readonly released: boolean;
  readonly finished: boolean;
  /** Closed by a `leaseStateOf` check at its epoch: the next take names it (`takenOverFrom`). */
  readonly superseded: boolean;
  readonly yielded: boolean;
}

/** The whole state: leases by tree, marks by scope, results by effect, intents by call. */
export interface FencingState {
  readonly leases: Readonly<Record<string, ModelLease>>;
  readonly marks: Readonly<Record<string, number>>;
  readonly effects: Readonly<Record<string, number>>;
  readonly calls: Readonly<Record<string, ModelCall>>;
}

/** One intent as the outbound-call contract holds it. */
export interface ModelCall {
  readonly status: "pending" | "completed" | "failed";
  readonly attempt: number;
  readonly attemptOwner: string;
  readonly token: number;
  readonly leaseExecutionId: string;
}

/** Nothing stored yet. */
export const EMPTY_FENCING_STATE: FencingState = { leases: {}, marks: {}, effects: {}, calls: {} };

/** The key of one tree's lease. */
export const treeOf = (tenantId: string, rootExecutionId: string): string =>
  `${tenantId}|${rootExecutionId}`;

/** A lease answer, as the model and the checker compare it: its epoch and holder, or none. */
export type LeaseAnswer = { readonly epoch: number; readonly holder: string } | null;

/** One step of the model: the next state and what the store must answer. */
export interface ModelStep<TAnswer> {
  readonly state: FencingState;
  readonly answer: TAnswer;
}

/** Live at `now` while `expiresAt > now`, the one boundary of every check (#534). */
const isLive = (lease: ModelLease, now: number): boolean => lease.expiresAt > now;

/** Whether `lease` is the caller's own and still held at `now`: what renew, yield, reclaim need. */
const isHeldBy = (
  lease: ModelLease | undefined,
  holder: string,
  epoch: number,
  now: number,
): lease is ModelLease =>
  lease !== undefined &&
  !lease.released &&
  lease.epoch === epoch &&
  lease.holder === holder &&
  isLive(lease, now);

const withLease = (state: FencingState, tree: string, lease: ModelLease): FencingState => ({
  ...state,
  leases: { ...state.leases, [tree]: lease },
});

/** `acquire`: refused while another holder's lease is live, and for good once finished (#520). */
export function acquired(
  state: FencingState,
  tree: string,
  holder: string,
  length: number,
  now: number,
): ModelStep<LeaseAnswer> {
  const stored = state.leases[tree];
  if (stored !== undefined && (stored.finished || (!stored.released && isLive(stored, now))))
    return { state, answer: null };
  const epoch = (stored?.epoch ?? 0) + 1;
  const lease: ModelLease = {
    epoch,
    holder,
    expiresAt: now + length,
    released: false,
    finished: false,
    superseded: false,
    yielded: false,
  };
  return { state: withLease(state, tree, lease), answer: { epoch, holder } };
}

/** `renew`: the time left (the length asked for), or `null` once the caller's lease is over. */
export function renewed(
  state: FencingState,
  tree: string,
  holder: string,
  epoch: number,
  length: number,
  now: number,
): ModelStep<number | null> {
  const stored = state.leases[tree];
  if (!isHeldBy(stored, holder, epoch, now)) return { state, answer: null };
  return { state: withLease(state, tree, { ...stored, expiresAt: now + length }), answer: length };
}

/** `release` (and `finish`, for good): only the caller's own lease, whatever the time. */
export function released(
  state: FencingState,
  tree: string,
  holder: string,
  epoch: number,
  isFinish: boolean,
): ModelStep<null> {
  const stored = state.leases[tree];
  if (stored?.epoch !== epoch || stored.holder !== holder) return { state, answer: null };
  return {
    state: withLease(state, tree, {
      ...stored,
      released: true,
      finished: stored.finished || isFinish,
    }),
    answer: null,
  };
}

/** `yield`: `true` while the caller holds it. */
export function yielded(
  state: FencingState,
  tree: string,
  holder: string,
  epoch: number,
  now: number,
): ModelStep<boolean> {
  const stored = state.leases[tree];
  if (!isHeldBy(stored, holder, epoch, now)) return { state, answer: false };
  return { state: withLease(state, tree, { ...stored, yielded: true }), answer: true };
}

/** `reclaim`: the caller's lease at the next epoch, held again for `length`. */
export function reclaimed(
  state: FencingState,
  tree: string,
  holder: string,
  epoch: number,
  length: number,
  now: number,
): ModelStep<LeaseAnswer> {
  const stored = state.leases[tree];
  if (!isHeldBy(stored, holder, epoch, now)) return { state, answer: null };
  const lease: ModelLease = {
    ...stored,
    epoch: epoch + 1,
    expiresAt: now + length,
    yielded: false,
  };
  return { state: withLease(state, tree, lease), answer: { epoch: epoch + 1, holder } };
}

/** `leaseStateOf`: live, ended, or superseded — an expired lease closed by this very check. */
export function leaseStateAt(
  state: FencingState,
  tree: string,
  token: number,
  now: number,
): ModelStep<"live" | "ended" | "superseded"> {
  const stored = state.leases[tree];
  if (stored === undefined || stored.released || stored.epoch !== token)
    return { state, answer: "ended" };
  if (isLive(stored, now)) return { state, answer: "live" };
  return {
    state: withLease(state, tree, { ...stored, released: true, superseded: true }),
    answer: "superseded",
  };
}

/** A fenced key: the lease it names, its token, the scope of its mark. */
export interface FencedKeyFacts {
  readonly tree: string;
  readonly token: number;
  readonly scope: string;
}

/**
 * The fence every write and fenced read passes first: the key's lease at its token, not released
 * and live, then the scope's mark (`token < highest` refused) — passed, the mark is raised.
 * `undefined` when it refuses.
 */
export function fenced(
  state: FencingState,
  key: FencedKeyFacts,
  now: number,
): FencingState | undefined {
  const lease = state.leases[key.tree];
  if (lease === undefined || lease.released || lease.epoch !== key.token || !isLive(lease, now))
    return undefined;
  const highest = state.marks[key.scope] ?? 0;
  if (key.token < highest) return undefined;
  return { ...state, marks: { ...state.marks, [key.scope]: Math.max(highest, key.token) } };
}

/** The step's fenced effect: `ran` the first time, `replayed` after, `fenced` when refused. */
export function effectWritten(
  state: FencingState,
  key: FencedKeyFacts,
  identity: string,
  now: number,
): ModelStep<"ran" | "replayed" | "fenced"> {
  const passed = fenced(state, key, now);
  if (passed === undefined) return { state, answer: "fenced" };
  if (passed.effects[identity] !== undefined) return { state: passed, answer: "replayed" };
  return {
    state: { ...passed, effects: { ...passed.effects, [identity]: key.token } },
    answer: "ran",
  };
}
