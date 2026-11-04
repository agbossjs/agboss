/**
 * #750 AC2 — histories generated from the sequential model itself are linearizable by construction:
 * each operation's answer is the model's (`acquired`, `renewed`, `leaseStateAt`) at a real instant,
 * its span drawn around that instant. The checker must find a linearization for every one — a
 * report is a false positive. Seeded (xorshift), so a failure names its seed; seeds 24 520 and
 * 46 470 are the two chains of expiries #660's one hop missed (the acquire pinned by a renewal
 * pinned inside its span).
 */
import { describe, expect, it } from "vitest";
import {
  acquired,
  EMPTY_FENCING_STATE,
  leaseStateAt,
  renewed,
  treeOf,
  type FencingState,
} from "../../../src/testing/contracts/models/lease-model.js";
import { linearizabilityOf } from "../../../src/testing/faults/linearizability/check.js";
import { OperationHistory, OperationPhase } from "../../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";

const LEASE = 50;
const TREE = treeOf("default", "tree-1");
const HOLDERS = ["a", "b", "c"] as const;

/** A seeded xorshift: the same numbers in `[0, 1)` for the same seed. */
function randomOf(seed: number): (below: number) => number {
  let at = seed >>> 0 || 1;
  return (below) => {
    at ^= at << 13;
    at ^= at >>> 17;
    at ^= at << 5;
    return Math.floor(((at >>> 0) / 4_294_967_296) * below);
  };
}

/** One operation as the model answers it at its instant. */
interface Step {
  readonly operation: StoreHoldPoint;
  readonly input: object;
  readonly output: unknown;
}

/** What `holder` does at `now` on `state` (`kind` 0 a take, 1 a renewal, 2 a read of its lease). */
function stepOf(
  model: { state: FencingState; epochs: Map<string, number> },
  holder: string,
  kind: number,
  now: number,
): Step {
  const epoch = model.epochs.get(holder);
  const held = { tenantId: "default", rootExecutionId: "tree-1", lease: LEASE };
  if (kind === 0 || epoch === undefined) {
    const step = acquired(model.state, TREE, holder, LEASE, now);
    model.state = step.state;
    if (step.answer !== null) model.epochs.set(holder, step.answer.epoch);
    const output =
      step.answer === null
        ? null
        : { holderInstanceId: holder, leaseEpoch: step.answer.epoch, rootExecutionId: "tree-1" };
    return { operation: StoreHoldPoint.LeaseAcquire, input: held, output };
  }
  if (kind === 1) {
    const step = renewed(model.state, TREE, holder, epoch, LEASE, now);
    model.state = step.state;
    const input = { ...held, holderInstanceId: holder, leaseEpoch: epoch };
    return { operation: StoreHoldPoint.LeaseRenew, input, output: step.answer };
  }
  const step = leaseStateAt(model.state, TREE, epoch, now);
  model.state = step.state;
  const input = { tenantId: "default", leaseExecutionId: "tree-1", token: epoch };
  return { operation: StoreHoldPoint.OutboundLeaseStateOf, input, output: step.answer };
}

/** The history of `seed`: 4–13 operations of three holders, spans up to a lease around each instant. */
function historyOf(seed: number): OperationHistory {
  const random = randomOf(seed);
  const count = 4 + random(10);
  const drawn = Array.from({ length: count }, () => 1 + random(4 * LEASE));
  const instants = [...new Set(drawn)].sort((left, right) => left - right);
  const model = { state: EMPTY_FENCING_STATE, epochs: new Map<string, number>() };
  const history = new OperationHistory();
  instants.forEach((now, index) => {
    const holder = HOLDERS[random(3)] ?? "a";
    const { operation, input, output } = stepOf(model, holder, random(3), now);
    const wide = random(2) === 0 ? LEASE : LEASE / 5;
    const from = Math.max(0, now - random(wide));
    const to = now + random(wide);
    const id = `${holder}#${String(index)}`;
    const base = { id, process: id, instanceId: holder, operation, key: undefined };
    const at = (ms: number) => String(BigInt(ms) * 1_000_000n);
    history.record({ ...base, phase: OperationPhase.Invoke, input, at: at(from) });
    history.record({ ...base, phase: OperationPhase.Complete, output, at: at(to) });
  });
  return history;
}

/** The seeds of `seeds` the checker reports a part of. */
const reportedOf = (seeds: readonly number[]): readonly number[] =>
  seeds.filter((seed) => linearizabilityOf(historyOf(seed), { slack: 0 }).length > 0);

describe("#750 AC2: histories the model itself answers are linearizable", () => {
  it("the two chains of expiries #660 missed pass", () => {
    expect(reportedOf([24_520, 46_470])).toEqual([]);
  });

  it("3 000 seeded histories: no false positive", () => {
    const seeds = Array.from({ length: 3_000 }, (_, at) => at + 1);

    expect(reportedOf(seeds)).toEqual([]);
  }, 120_000);

  it("bites: a refused take turned into a grant of an epoch nobody had is reported", () => {
    const turned = new OperationHistory();
    for (const event of historyOf(24_520).events) {
      const isRefusedTake =
        event.operation === StoreHoldPoint.LeaseAcquire &&
        event.phase === OperationPhase.Complete &&
        event.output === null;
      const grant = {
        holderInstanceId: event.instanceId,
        leaseEpoch: 99,
        rootExecutionId: "tree-1",
      };
      turned.record(isRefusedTake ? { ...event, output: grant } : event);
    }

    expect(linearizabilityOf(turned, { slack: 0 })).toHaveLength(1);
  });
});
