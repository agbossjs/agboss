/**
 * #533 item 5: the linearizability checker on histories written by hand — a sound one passes, with
 * overlapping operations in either order; a double owner (an epoch granted twice, a take of a live
 * lease, a renewal after a newer grant), a write at a superseded token, a lost compare-and-set and
 * a take of finished work fail; an operation nobody saw answer may or may not have taken effect.
 */
import { describe, expect, it } from "vitest";
import { linearizabilityOf } from "../../../src/testing/faults/linearizability/check.js";
import { OperationHistory, OperationPhase } from "../../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";

/** A history being written: each operation from `from` to `to` ms of the store's time. */
class Recorded {
  readonly history = new OperationHistory();
  #count = 0;

  op(
    kind: StoreHoldPoint,
    holder: string,
    input: object,
    output: unknown,
    from: number,
    to?: number,
  ): this {
    this.#count += 1;
    const id = `${holder}#${String(this.#count)}`;
    const base = { id, process: holder, instanceId: holder, operation: kind, key: undefined };
    this.history.record({
      ...base,
      phase: OperationPhase.Invoke,
      input,
      at: String(BigInt(from) * 1_000_000n),
    });
    if (to !== undefined) {
      const done =
        output === "fenced"
          ? { error: { name: "ExecutionFencedError", message: "fenced" } }
          : { output };
      this.history.record({
        ...base,
        phase: OperationPhase.Complete,
        ...done,
        at: String(BigInt(to) * 1_000_000n),
      });
    }
    return this;
  }
}

const TREE = { tenantId: "default", rootExecutionId: "tree-1", lease: 30_000 };
const lease = (holder: string, epoch: number) => ({
  tenantId: "default",
  rootExecutionId: "tree-1",
  holderInstanceId: holder,
  leaseEpoch: epoch,
  lease: 30_000,
});
const granted = (holder: string, epoch: number) => ({
  holderInstanceId: holder,
  leaseEpoch: epoch,
  rootExecutionId: "tree-1",
});
const key = (token: number) => ({
  scopeKey: "default:tree-1",
  tenantId: "default",
  leaseExecutionId: "tree-1",
  token,
  idempotencyKey: "tree-1:charge-action:1",
  name: "charge",
});

const stateOf = (token: number) => ({ tenantId: "default", leaseExecutionId: "tree-1", token });

const failures = (recorded: Recorded) => linearizabilityOf(recorded.history, { slack: 0 });

describe("#533 item 5: the linearizability checker", () => {
  it("a sound history passes: a take, renewals, a release, the other's take, a write under each", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.FencedEffectWrite, "a", key(1), { status: "ran", token: 1 }, 10, 12)
      .op(StoreHoldPoint.LeaseRenew, "a", lease("a", 1), 30_000, 10_000, 10_002)
      .op(StoreHoldPoint.LeaseRelease, "a", lease("a", 1), null, 20_000, 20_001)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 20_005, 20_006)
      .op(
        StoreHoldPoint.FencedEffectWrite,
        "b",
        key(2),
        { status: "replayed", token: 1 },
        20_010,
        20_011,
      );

    expect(failures(history)).toEqual([]);
  });

  it("two takes that overlap: the refused one may come first or last", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 20)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, null, 5, 10);

    expect(failures(history)).toEqual([]);
  });

  it("bites: an epoch granted twice — a double owner", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 1), 10, 15);

    const [part] = failures(history);
    expect(part?.stuck.map((operation) => operation.id)).toEqual(["b#2"]);
  });

  it("bites: the other instance takes a lease 1 s into it — its holder still had 29 s", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 1_000, 1_005);

    expect(failures(history)).toHaveLength(1);
  });

  it("the same take after the lease's end passes", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 30_010, 30_015);

    expect(failures(history)).toEqual([]);
  });

  it("bites: a renewal that lands after a newer epoch was granted, and a write at the old token", () => {
    const renewal = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 30_010, 30_015)
      .op(StoreHoldPoint.LeaseRenew, "a", lease("a", 1), 30_000, 30_020, 30_025);
    const write = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 30_010, 30_015)
      .op(
        StoreHoldPoint.FencedEffectWrite,
        "a",
        key(1),
        { status: "ran", token: 1 },
        30_020,
        30_025,
      );

    expect(failures(renewal)).toHaveLength(1);
    expect(failures(write)).toHaveLength(1);
  });

  it("bites: a take of finished work", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.LeaseFinish, "a", lease("a", 1), null, 10, 12)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 20, 25);

    expect(failures(history)).toHaveLength(1);
  });

  it("bites: a take invoked right after a finish completed — the slack widens instants, never the order", () => {
    // fault scenario 6b on a finish that is a release: the release inside the finish's span, the
    // other's take invoked 1 ms after the finish answered, well within the 50 ms slack
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.LeaseFinish, "a", lease("a", 1), null, 100, 103)
      .op(StoreHoldPoint.LeaseRelease, "a", lease("a", 1), null, 101, 102)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 104, 108);

    expect(linearizabilityOf(history.history, { slack: 50 })).toHaveLength(1);
  });

  it("bites: two claims of the next attempt from one read, both won", () => {
    const call = (claimer: string) => ({
      ...key(1),
      businessKey: "order:1",
      expected: { status: "failed", attempt: 1, attemptOwner: "o1" },
      claim: { attempt: 2, attemptOwner: claimer },
    });
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(
        StoreHoldPoint.OutboundSaveIfAbsent,
        "a",
        { ...key(1), businessKey: "order:1", attemptOwner: "o1" },
        true,
        10,
        11,
      )
      .op(
        StoreHoldPoint.OutboundMarkFailed,
        "a",
        { ...key(1), businessKey: "order:1", attemptOwner: "o1" },
        true,
        20,
        21,
      )
      .op(StoreHoldPoint.OutboundMarkPending, "a", call("o2"), true, 30, 40)
      .op(StoreHoldPoint.OutboundMarkPending, "a", call("o3"), true, 32, 38);

    expect(failures(history)).toHaveLength(1);
  });

  it("an operation whose answer nobody saw: a write that never completed may have landed or not", () => {
    const landed = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.FencedEffectWrite, "a", key(1), undefined, 10)
      .op(StoreHoldPoint.FencedEffectWrite, "a", key(1), { status: "replayed", token: 1 }, 20, 21);
    const lost = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 5)
      .op(StoreHoldPoint.FencedEffectWrite, "a", key(1), undefined, 10)
      .op(StoreHoldPoint.FencedEffectWrite, "a", key(1), { status: "ran", token: 1 }, 20, 21);

    expect(failures(landed)).toEqual([]);
    expect(failures(lost)).toEqual([]);
  });

  it("bites (#617): a take of a live lease inside 10–12 ms is not excused by a renewal in flight past the expiry", () => {
    // the holder's pod frozen mid-renewal (scenarios 5b, 5c, 13): its renewal spans the expiry, and
    // no operation takes effect after it completed — b's take lands at 10–12 ms, a's lease live
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 1)
      .op(StoreHoldPoint.LeaseRenew, "a", lease("a", 1), null, 2, 40_000)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 10, 12);

    const [part] = failures(history);
    expect(part?.stuck.map((operation) => operation.id)).toContain("b#3");
  });

  it("#617: a take stalled across the expiry lands at it — the old holder's lease state in the middle is Ended", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 1)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 20_000, 40_000)
      .op(StoreHoldPoint.OutboundLeaseStateOf, "a", stateOf(1), "ended", 31_000, 31_005);

    expect(failures(history)).toEqual([]);
  });

  it("#617: a take nobody saw answer may land any time after its invoke — after a's expiry, so c's take past b's is epoch 3", () => {
    // b's pod killed with its take in flight; the store applied it at a's expiry (30 s): b's lease
    // runs to 60 s, and c's take after that is the third epoch
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 1)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, undefined, 20_000)
      .op(StoreHoldPoint.LeaseAcquire, "c", TREE, granted("c", 3), 61_000, 61_001);
    const tooEarly = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 1)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, undefined, 20_000)
      .op(StoreHoldPoint.LeaseAcquire, "c", TREE, granted("c", 3), 25_000, 25_001);

    expect(failures(history)).toEqual([]);
    expect(failures(tooEarly)).toHaveLength(1);
  });

  it("#617: a stale read across two processes — the old token Live after the newer grant completed — fails", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 1)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 30_010, 30_011)
      .op(StoreHoldPoint.OutboundLeaseStateOf, "a", stateOf(1), "live", 30_020, 30_021);

    expect(failures(history)).toHaveLength(1);
  });

  it("the store's time is the machine's times the scale: 3 s of a 10× run are 30 s of the store's", () => {
    const history = new Recorded()
      .op(StoreHoldPoint.LeaseAcquire, "a", TREE, granted("a", 1), 0, 1)
      .op(StoreHoldPoint.LeaseAcquire, "b", TREE, granted("b", 2), 3_010, 3_011);

    expect(linearizabilityOf(history.history, { timeScale: 10, slack: 0 })).toEqual([]);
    expect(linearizabilityOf(history.history, { timeScale: 1, slack: 0 })).toHaveLength(1);
  });
});
