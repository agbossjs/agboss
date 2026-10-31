import { describe, expect, it } from "vitest";
import type { ExecutionHistoryRecord } from "../../../src/infrastructure/execution-history.repository.js";
import {
  ExecutionLeaseEventKind,
  FencedEffectEventOutcome,
  OutboundCallEventOutcome,
  type ExecutionLeaseEventRecord,
} from "../../../src/infrastructure/execution-lease-event.repository.js";
import type { FaultRun, PodEventFact } from "../../../src/testing/faults/facts.js";
import {
  assertFaultInvariants,
  faultViolationsOf,
} from "../../../src/testing/faults/invariants/check.js";
import {
  FaultInvariant,
  FaultInvariantError,
} from "../../../src/testing/faults/invariants/violations.js";
import { OperationHistory, OperationPhase } from "../../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";

/**
 * #484 AC1 — the invariant checker fails on a broken run: each invariant on a run that breaks it,
 * and a healthy run passes. The runs are written by hand: the history of store operations, the
 * kept records, the lease logs, the business rows, the gateway and the pods' events.
 */

let at = 0n;
/** One store operation of the history, its invoke and complete one after the other. */
function operation(
  history: OperationHistory,
  fields: {
    process: string;
    operation: StoreHoldPoint;
    key: string;
    input?: unknown;
    output?: unknown;
    error?: { name: string; message: string };
  },
): void {
  at += 10n;
  const id = `${fields.process}#${String(at)}`;
  const base = {
    id,
    process: fields.process,
    instanceId: fields.process,
    operation: fields.operation,
    key: fields.key,
  };
  history.record({ ...base, phase: OperationPhase.Invoke, input: fields.input, at: String(at) });
  history.record({
    ...base,
    phase: OperationPhase.Complete,
    at: String(at + 1n),
    ...(fields.error === undefined ? { output: fields.output ?? null } : { error: fields.error }),
  });
}

const lease = (holder: string, epoch: number, root = "root-1") => ({
  rootExecutionId: root,
  leaseEpoch: epoch,
  holderInstanceId: holder,
});
const key = (token: number, root = "root-1") => ({
  leaseExecutionId: root,
  token,
  scopeKey: root,
  tenantId: "default",
  idempotencyKey: `${root}:charge`,
  name: "charge",
});

/** A kept record of a root order tree. */
const orderRecord = (
  orderId: string,
  executionId: string,
  overrides: Partial<ExecutionHistoryRecord> = {},
): ExecutionHistoryRecord =>
  ({
    executionId,
    rootExecutionId: executionId,
    start: { name: "fault-order-workflow-start" },
    input: { orderId, decline: false },
    status: "finished",
    finish: { name: "fault-order-workflow-finish" },
    output: { orderId },
    children: [],
    compensations: [],
    ...overrides,
  }) as Partial<ExecutionHistoryRecord> as ExecutionHistoryRecord;

/** A healthy run of one order: a takes epoch 1, charges once, pays once. */
function healthy(): { run: FaultRun; history: OperationHistory } {
  const history = new OperationHistory();
  operation(history, {
    process: "a",
    operation: StoreHoldPoint.LeaseAcquire,
    key: "root-1",
    output: lease("a", 1),
  });
  operation(history, {
    process: "a",
    operation: StoreHoldPoint.FencedEffectWrite,
    key: "root-1",
    input: key(1),
    output: { status: "ran", token: 1 },
  });
  const leaseEvents: ExecutionLeaseEventRecord[] = [
    {
      kind: ExecutionLeaseEventKind.FencedEffect,
      executionId: "root-1",
      name: "charge",
      outcome: FencedEffectEventOutcome.Ran,
    } as Partial<ExecutionLeaseEventRecord> as ExecutionLeaseEventRecord,
    {
      kind: ExecutionLeaseEventKind.OutboundCall,
      executionId: "root-1",
      name: "pay",
      outcome: OutboundCallEventOutcome.Sent,
    } as Partial<ExecutionLeaseEventRecord> as ExecutionLeaseEventRecord,
  ];
  const run: FaultRun = {
    records: [orderRecord("o-1", "root-1")],
    trees: [{ rootExecutionId: "root-1", leaseEvents, outboundCalls: [] }],
    businessRows: ["charge:root-1"],
    orders: [{ orderId: "o-1", decline: false }],
    requests: [{ pod: "a", idempotencyKey: "default:order%3Ao-1:pay", orderId: "o-1" }],
    payments: [{ paymentId: "pay-1", idempotencyKey: "default:order%3Ao-1:pay" }],
    events: [{ type: "end", pod: "a", executionId: "root-1" }],
    history,
  };
  return { run, history };
}

const invariantsOf = (run: FaultRun): readonly FaultInvariant[] => [
  ...new Set(faultViolationsOf(run).map((found) => found.invariant)),
];

describe("#484 AC1: the invariant checker fails on a broken run", () => {
  it("a healthy run breaks nothing", () => {
    expect(faultViolationsOf(healthy().run)).toEqual([]);
    expect(() => {
      assertFaultInvariants("healthy", healthy().run);
    }).not.toThrow();
  });

  it("two owners: one epoch granted to two instances", () => {
    const { run, history } = healthy();
    operation(history, {
      process: "b",
      operation: StoreHoldPoint.LeaseAcquire,
      key: "root-1",
      output: lease("b", 1),
    });
    expect(invariantsOf(run)).toEqual([FaultInvariant.OneOwner]);
  });

  it("two owners: an epoch granted after a higher one, a write from an instance that did not hold its epoch", () => {
    const { run, history } = healthy();
    operation(history, {
      process: "b",
      operation: StoreHoldPoint.LeaseAcquire,
      key: "root-2",
      output: lease("b", 3, "root-2"),
    });
    operation(history, {
      process: "b",
      operation: StoreHoldPoint.LeaseReclaim,
      key: "root-2",
      output: lease("b", 2, "root-2"),
    });
    operation(history, {
      process: "c",
      operation: StoreHoldPoint.OutboundMarkCompleted,
      key: "root-2",
      input: key(3, "root-2"),
      output: true,
    });
    const messages = faultViolationsOf(run).map((found) => found.message);
    expect(messages).toEqual([
      expect.stringContaining("granted after a higher one"),
      expect.stringContaining("was accepted from c, but b held that epoch"),
    ]);
  });

  it("a stale write: accepted at token 1 after epoch 2 was granted", () => {
    const { run, history } = healthy();
    operation(history, {
      process: "b",
      operation: StoreHoldPoint.LeaseAcquire,
      key: "root-1",
      output: lease("b", 2),
    });
    operation(history, {
      process: "a",
      operation: StoreHoldPoint.OutboundSaveIfAbsent,
      key: "root-1",
      input: key(1),
      output: true,
    });
    // refused writes and refused grants are no acceptance
    operation(history, {
      process: "a",
      operation: StoreHoldPoint.OutboundMarkPending,
      key: "root-1",
      input: key(1),
      output: false,
    });
    operation(history, {
      process: "a",
      operation: StoreHoldPoint.FencedEffectWrite,
      key: "root-1",
      input: key(1),
      error: { name: "ExecutionFencedError", message: "fenced" },
    });
    operation(history, {
      process: "c",
      operation: StoreHoldPoint.LeaseAcquire,
      key: "root-1",
      output: null,
    });
    expect(faultViolationsOf(run).map((found) => found.message)).toEqual([
      expect.stringContaining("a stale write"),
    ]);
  });

  it("two takeovers of one token in the lease log", () => {
    const { run } = healthy();
    const takeover = {
      kind: ExecutionLeaseEventKind.Takeover,
      executionId: "root-1",
      token: 2,
    } as Partial<ExecutionLeaseEventRecord> as ExecutionLeaseEventRecord;
    const trees = [
      { rootExecutionId: "root-1", leaseEvents: [takeover, takeover], outboundCalls: [] },
    ];
    expect(invariantsOf({ ...run, trees })).toEqual([FaultInvariant.OneOwner]);
  });

  it("finished work taken again: a lease granted after it was finished", () => {
    const { run, history } = healthy();
    operation(history, {
      process: "a",
      operation: StoreHoldPoint.LeaseFinish,
      key: "root-1",
      input: lease("a", 1),
    });
    operation(history, {
      process: "a",
      operation: StoreHoldPoint.LeaseFinish,
      key: "root-1",
      input: lease("a", 1),
    });
    operation(history, {
      process: "b",
      operation: StoreHoldPoint.LeaseAcquire,
      key: "root-1",
      output: lease("b", 2),
    });
    expect(invariantsOf(run)).toEqual([FaultInvariant.FinishedWorkUntouched]);
  });

  it("a duplicate charge: two business rows, two Ran rows", () => {
    const { run } = healthy();
    const ran = run.trees[0]?.leaseEvents[0];
    const trees = [
      {
        rootExecutionId: "root-1",
        leaseEvents: [ran, ran].filter((row) => row !== undefined),
        outboundCalls: [],
      },
    ];
    expect(
      faultViolationsOf({ ...run, trees, businessRows: ["charge:root-1", "charge:root-1"] }).map(
        (found) => found.invariant,
      ),
    ).toEqual([FaultInvariant.EffectsOnce, FaultInvariant.EffectsOnce]);
  });

  it("a duplicate payment: two keys, two requests, two payments, two Sent rows", () => {
    const { run } = healthy();
    const sent = run.trees[0]?.leaseEvents[1];
    const trees = [
      {
        rootExecutionId: "root-1",
        leaseEvents: [sent, sent].filter((row) => row !== undefined),
        outboundCalls: [],
      },
    ];
    const requests = [...run.requests, { pod: "b", idempotencyKey: "other", orderId: "o-1" }];
    const payments = [...run.payments, { paymentId: "pay-2", idempotencyKey: "other" }];
    expect(
      faultViolationsOf({ ...run, trees, requests, payments }).map((found) => found.message),
    ).toEqual([
      expect.stringContaining("under 2 idempotency keys"),
      expect.stringContaining("2 times (from a, b)"),
      expect.stringContaining("paid 2 times"),
      expect.stringContaining("2 Sent rows"),
    ]);
  });

  it("a finished order with no charge or no payment", () => {
    const { run } = healthy();
    expect(invariantsOf({ ...run, businessRows: [], payments: [] })).toEqual([
      FaultInvariant.EffectsOnce,
    ]);
  });

  it("a hand-over that undid the reservation; a declined order undone not once", () => {
    const { run } = healthy();
    const released: PodEventFact = { type: "released", pod: "a", executionId: "root-1" };
    expect(invariantsOf({ ...run, events: [...run.events, released] })).toEqual([
      FaultInvariant.NoUndoOnHandOver,
    ]);
    const declined = {
      ...run,
      orders: [{ orderId: "o-1", decline: true }],
      records: [orderRecord("o-1", "root-1", { status: "failed" as never })],
      businessRows: [],
      payments: [],
      requests: [],
    };
    expect(invariantsOf(declined)).toEqual([FaultInvariant.NoUndoOnHandOver]);
  });

  it("a tree that never finished: no record, or still running; a batch unfinished", () => {
    const { run } = healthy();
    expect(invariantsOf({ ...run, records: [] })).toContain(FaultInvariant.TreesFinish);
    expect(
      invariantsOf({
        ...run,
        records: [orderRecord("o-1", "root-1", { status: "paused" as never })],
      }),
    ).toContain(FaultInvariant.TreesFinish);
    const batch = orderRecord("o-1", "batch-1", {
      start: { name: "fault-batch-workflow-start" } as never,
      input: [{ orderId: "o-1" }],
      status: "failed" as never,
      children: [],
    });
    expect(invariantsOf({ ...run, records: [...run.records, batch] })).toEqual([
      FaultInvariant.ChildrenOnce,
      FaultInvariant.TreesFinish,
    ]);
  });

  it("a child lost, a child run twice, an execution ended twice", () => {
    const { run } = healthy();
    const child = (executionId: string, orderId: string, status = "finished") => ({
      executionId,
      rootExecutionId: "batch-1",
      input: { orderId },
      status,
      finish: { name: "fault-order-workflow-finish" },
    });
    const batch = orderRecord("o-1", "batch-1", {
      start: { name: "fault-batch-workflow-start" } as never,
      input: [{ orderId: "o-1" }, { orderId: "o-2" }],
      finish: { name: "fault-batch-workflow-finish" } as never,
      children: [
        child("c-1", "o-1"),
        child("c-1", "o-1"),
        child("c-2", "o-2", "cancelled"),
      ] as never,
    });
    const twice: PodEventFact = { type: "end", pod: "b", executionId: "root-1" };
    const found = faultViolationsOf({
      ...run,
      records: [...run.records, batch],
      events: [...run.events, twice],
    });
    expect(
      found
        .filter((each) => each.invariant === FaultInvariant.ChildrenOnce)
        .map((each) => each.message),
    ).toEqual([
      expect.stringContaining("has children o-1, o-1, o-2"),
      expect.stringContaining("child c-2 of batch batch-1 is cancelled"),
      "execution root-1 ended twice",
    ]);
  });

  it("names every violation in its error", () => {
    const { run } = healthy();
    const broken = { ...run, records: [] };
    expect(() => {
      assertFaultInvariants("s99-broken", broken);
    }).toThrow(FaultInvariantError);
    try {
      assertFaultInvariants("s99-broken", broken);
    } catch (error) {
      expect(error).toMatchObject({
        scenario: "s99-broken",
        invariants: [FaultInvariant.TreesFinish],
      });
      expect(String(error)).toContain("[trees-finish] o-1 never finished (no record)");
    }
    expect(new FaultInvariantError("s", [], ["a wait ran out"]).message).toContain(
      "(also) a wait ran out",
    );
  });
});
