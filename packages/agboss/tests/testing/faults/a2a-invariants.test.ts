import { describe, expect, it } from "vitest";
import { SqliteA2ATaskRepository } from "../../../src/a2a/index.js";
import type { ExecutionHistoryRecord } from "../../../src/infrastructure/execution-history.repository.js";
import {
  SqliteExecutionLeaseRepository,
  SqlitePausedExecutionRepository,
} from "../../../src/index.js";
import type { FaultRun, PodEventFact } from "../../../src/testing/faults/facts.js";
import { keepsA2ATasks } from "../../../src/testing/faults/fixture/fault.a2a.js";
import { heldMethodsOf } from "../../../src/testing/faults/held-stores.js";
import { a2aTaskViolations } from "../../../src/testing/faults/invariants/a2a-tasks.js";
import { OperationHistory, OperationPhase } from "../../../src/testing/faults/operation-history.js";
import { podA2AOf } from "../../../src/testing/faults/pod-protocol.js";
import { answerOf } from "../../../src/testing/faults/scenarios/a2a-wire.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";

/**
 * #811 AC4 — `a2a-tasks-once` fails on a broken run, on every task id the run names: a state told
 * after a terminal one, a status written over a terminal one, writes that are no version chain (a
 * lost update), an id kept twice, a step or an effect of a task settled start-lost, an effect a
 * canceled task committed after its cancel was durable (#909: with no window, an undo's and a
 * child's counted right), CANCELED told with no cancel, two undos — and a healthy run passes. The runs
 * are written by hand, on monotonic times given here; the scenarios' sabotages
 * (tests/faults/sabotage.test.ts) bite on pods. Then the A2A wire a scenario reads and a pod's
 * ready event: what is no answer is said, never read as one.
 */

const TASK = "task-1";
const SECOND = 1_000_000_000n;

let ids = 0;

/** One operation of the history: invoked at `at`, answered `output` (or `error`) 1 ns later. */
function operation(
  history: OperationHistory,
  fields: {
    readonly process?: string;
    readonly operation: StoreHoldPoint;
    readonly key: string;
    readonly at: bigint;
    readonly input?: unknown;
    readonly output?: unknown;
  },
): void {
  ids += 1;
  const process = fields.process ?? "a";
  const base = {
    id: `${process}#${String(ids)}`,
    process,
    instanceId: process,
    operation: fields.operation,
    key: fields.key,
  };
  history.record({
    ...base,
    phase: OperationPhase.Invoke,
    input: fields.input,
    at: String(fields.at),
  });
  history.record({
    ...base,
    phase: OperationPhase.Complete,
    output: fields.output ?? null,
    at: String(fields.at + 1n),
  });
}

/** A status write from `from`, accepted as `from + 1` (`state`) or refused (`null`). */
const written = (
  history: OperationHistory,
  at: bigint,
  from: number,
  state: string | null,
  extra: Readonly<Record<string, unknown>> = {},
  process = "a",
): void => {
  operation(history, {
    process,
    operation: StoreHoldPoint.A2ATaskStatusWrite,
    key: TASK,
    at,
    input: { expectedVersion: from },
    output: state === null ? null : { version: from + 1, state, ...extra },
  });
};

const told = (pod: string, state: string, code?: string): PodEventFact => ({
  type: "a2a-answer",
  method: "GetTask",
  taskId: TASK,
  state,
  ...(code === undefined ? {} : { code }),
  pod,
});

const step = (point: string, pod = "a"): PodEventFact => ({
  type: "step",
  point,
  rootExecutionId: TASK,
  executionId: TASK,
  orderId: "o-1",
  pod,
});

const asked = (method: string): PodEventFact => ({
  type: "a2a-asked",
  method,
  taskId: TASK,
  pod: "b",
});

/** The tree's cancel made durable (#909: the lease store's mark, every cancel's first write), at `at`. */
const cancelRequested = (history: OperationHistory, at: bigint): void => {
  operation(history, {
    process: "b",
    operation: StoreHoldPoint.LeaseRequestCancel,
    key: TASK,
    at,
    input: { tenantId: "default", rootExecutionId: TASK },
  });
};

/** The fenced charge of the tree, run at `at`; `isCompensation`: an undo's key (#909). */
const charged = (history: OperationHistory, at: bigint, isCompensation = false): void => {
  operation(history, {
    operation: StoreHoldPoint.FencedEffectWrite,
    key: TASK,
    at,
    input: { rootExecutionId: TASK, ...(isCompensation ? { isCompensation: true } : {}) },
    output: { status: "ran", token: 1 },
  });
};

/** A run of these events, history and root records, nothing else; the pods' clock 10× real. */
const runOf = (
  events: readonly PodEventFact[],
  history = new OperationHistory(),
  records: readonly ExecutionHistoryRecord[] = [],
): FaultRun => ({
  records,
  trees: [],
  businessRows: [],
  orders: [],
  requests: [],
  payments: [],
  events,
  history,
  timeScale: 10,
});

const messagesOf = (run: FaultRun): readonly string[] =>
  a2aTaskViolations(run).map((found) => found.message);

describe("#811 AC4: one execution per A2A task, its end for good", () => {
  it("a healthy run passes: start-lost told everywhere, a version chain, the refused write after it", () => {
    const history = new OperationHistory();
    written(history, 10n, 1, "TASK_STATE_SUBMITTED", { cancelRequested: true });
    written(history, 20n, 2, "TASK_STATE_FAILED", { errorCode: "a2a.start-lost" }, "b");
    written(history, 30n, 2, null);
    const run = runOf(
      [
        told("b", "TASK_STATE_SUBMITTED"),
        told("b", "TASK_STATE_FAILED", "a2a.start-lost"),
        told("a", "TASK_STATE_FAILED", "a2a.start-lost"),
      ],
      history,
    );

    expect(a2aTaskViolations(run)).toEqual([]);
  });

  it("a caller told another state after a terminal one", () => {
    const run = runOf([told("b", "TASK_STATE_FAILED"), told("a", "TASK_STATE_CANCELED")]);

    expect(messagesOf(run)).toContain(
      `task ${TASK} was told TASK_STATE_FAILED on b, then TASK_STATE_CANCELED on a`,
    );
  });

  it("a status written over a terminal one — on a task no caller heard of", () => {
    const history = new OperationHistory();
    cancelRequested(history, 5n);
    written(history, 10n, 1, "TASK_STATE_FAILED", {}, "b");
    written(history, 20n, 2, "TASK_STATE_CANCELED");

    expect(messagesOf(runOf([], history))).toEqual([
      `task ${TASK}'s status TASK_STATE_CANCELED was written by a after it was written TASK_STATE_FAILED`,
    ]);
  });

  it("two writes accepted from one version: no version chain, an update lost", () => {
    const history = new OperationHistory();
    written(history, 10n, 1, "TASK_STATE_WORKING");
    written(history, 20n, 1, "TASK_STATE_INPUT_REQUIRED", {}, "b");

    expect(messagesOf(runOf([], history))).toEqual([
      `task ${TASK}'s status writes are no version chain: 1→2 by a, 1→2 by b — an update was lost`,
    ]);
  });

  it("the task's id kept twice: two starts under one task", () => {
    const history = new OperationHistory();
    for (const [process, at] of [
      ["b", 10n],
      ["a", 20n],
    ] as const)
      operation(history, {
        process,
        operation: StoreHoldPoint.LeaseClaimExecutionId,
        key: TASK,
        at,
        output: { kept: true },
      });

    expect(messagesOf(runOf([], history))).toEqual([
      `execution id ${TASK} was kept 2 times (by b, a): two starts under one task`,
    ]);
  });

  it("two root records under one task id", () => {
    const record = (status: string) =>
      ({ executionId: TASK, rootExecutionId: TASK, status }) as ExecutionHistoryRecord;
    const run = runOf([], undefined, [record("cancelled"), record("finished")]);

    expect(messagesOf(run)).toEqual([`task ${TASK} has 2 root records: cancelled, finished`]);
  });

  it("a task written start-lost that ran a step and charged — its id from the history alone", () => {
    const history = new OperationHistory();
    written(history, 10n, 1, "TASK_STATE_FAILED", { errorCode: "a2a.start-lost" });
    charged(history, 20n);

    expect(messagesOf(runOf([step("reserve")], history))).toEqual([
      `task ${TASK} was settled a2a.start-lost, yet ran reserve on a, fencedEffect.write by a`,
    ]);
  });
});

describe("#811 AC4: a canceled task, on the store's own history", () => {
  it("a charge committed after the cancel request was durable", () => {
    const history = new OperationHistory();
    cancelRequested(history, 10n);
    charged(history, 20n);
    const run = runOf([told("b", "TASK_STATE_CANCELED")], history);

    expect(messagesOf(run)).toEqual([
      `task ${TASK} was canceled, yet committed fencedEffect.write by a after its cancel was durable`,
    ]);
  });

  it("a step that began after the cancel was asked, with no effect after it: no false alarm", () => {
    const history = new OperationHistory();
    charged(history, 5n);
    cancelRequested(history, 10n);
    const run = runOf(
      [asked("CancelTask"), step("charge.before"), told("b", "TASK_STATE_CANCELED")],
      history,
    );

    expect(a2aTaskViolations(run)).toEqual([]);
  });

  it("CANCELED told with no cancel asked or written", () => {
    expect(messagesOf(runOf([told("a", "TASK_STATE_CANCELED")]))).toEqual([
      `task ${TASK} was told CANCELED, yet no cancel was asked or written`,
    ]);
  });

  it("#909: an undo's effect after the cancel is no violation — the cancel's own unwinding", () => {
    const history = new OperationHistory();
    cancelRequested(history, 10n);
    charged(history, 20n, true);

    expect(a2aTaskViolations(runOf([told("b", "TASK_STATE_CANCELED")], history))).toEqual([]);
  });

  it("#909: an effect of a child, whose lease is its own, is the root's after the cancel", () => {
    const history = new OperationHistory();
    cancelRequested(history, 10n);
    operation(history, {
      operation: StoreHoldPoint.FencedEffectWrite,
      key: "child-1",
      at: 20n,
      input: { rootExecutionId: TASK },
      output: { status: "ran", token: 1 },
    });

    expect(messagesOf(runOf([told("b", "TASK_STATE_CANCELED")], history))).toEqual([
      `task ${TASK} was canceled, yet committed fencedEffect.write by a after its cancel was durable`,
    ]);
  });

  it("a canceled task undone twice", () => {
    const released: PodEventFact = { type: "released", rootExecutionId: TASK, pod: "a" };
    const run = runOf([asked("CancelTask"), released, released, told("b", "TASK_STATE_CANCELED")]);

    expect(messagesOf(run)).toEqual([
      `task ${TASK} was canceled, and its reservation was released 2 times`,
    ]);
  });
});

describe("#811 AC4: only a JSON-RPC 2.0 answer to the call made is read", () => {
  const task = (state: unknown, id: unknown = TASK) => ({ id, status: { state } });

  it("a task with its state and code; an error's code", () => {
    const failed = {
      id: TASK,
      status: {
        state: "TASK_STATE_FAILED",
        message: { metadata: { "https://agboss.dev/a2a/mesh/v1": { code: "a2a.start-lost" } } },
      },
    };

    expect(answerOf(200, { jsonrpc: "2.0", id: 1, result: { task: failed } }, 1)).toEqual({
      taskId: TASK,
      state: "TASK_STATE_FAILED",
      code: "a2a.start-lost",
    });
    expect(answerOf(200, { jsonrpc: "2.0", id: 2, error: { code: -32004 } }, 2)).toEqual({
      errorCode: -32004,
    });
  });

  it("anything else is said, never read", () => {
    const ok = { jsonrpc: "2.0", id: 1, result: task("TASK_STATE_WORKING") };
    const cases: readonly (readonly [number, unknown])[] = [
      [503, ok],
      [200, { ...ok, jsonrpc: "1.0" }],
      [200, { ...ok, id: 2 }],
      [200, { jsonrpc: "2.0", id: 1 }],
      [200, { ...ok, error: { code: -32603 } }],
      [200, { jsonrpc: "2.0", id: 1, error: { code: "-32004" } }],
      [200, { jsonrpc: "2.0", id: 1, result: task("TASK_STATE_WORKING", "") }],
      [200, { jsonrpc: "2.0", id: 1, result: task("TASK_STATE_SLEEPING") }],
      [200, undefined],
    ];

    expect(cases.map(([status, body]) => typeof answerOf(status, body, 1))).toEqual(
      cases.map(() => "string"),
    );
  });

  it("a pod's ready event: whether its set keeps A2A tasks, and a URL or null — nothing else", () => {
    expect(podA2AOf({ type: "ready", keepsA2ATasks: true, a2aUrl: "http://127.0.0.1:1" })).toEqual({
      keepsA2ATasks: true,
      a2aUrl: "http://127.0.0.1:1",
    });
    expect(podA2AOf({ type: "ready", keepsA2ATasks: false, a2aUrl: null })).toEqual({
      keepsA2ATasks: false,
      a2aUrl: undefined,
    });
    expect(typeof podA2AOf({ type: "ready", a2aUrl: null })).toBe("string");
    expect(typeof podA2AOf({ type: "ready", keepsA2ATasks: true, a2aUrl: 7 })).toBe("string");
  });
});

describe("#811 AC4: the A2A hold points and the fixture's A2A", () => {
  it("the A2A task store, the pause store (its read too, #850) and the id keep are held contracts", () => {
    expect(Object.keys(heldMethodsOf(SqliteA2ATaskRepository) ?? {})).toEqual([
      "saveIfAbsent",
      "compareAndSetStatus",
    ]);
    expect(Object.keys(heldMethodsOf(SqlitePausedExecutionRepository) ?? {})).toEqual([
      "resolveByTenantIdAndPauseId",
      "cancelByTenantIdAndPauseId",
      "markSentByTenantIdAndPauseId",
      "expireByTenantIdAndPauseId",
      "closeUntakenByTenantIdAndPauseId",
      "extendByTenantIdAndPauseId",
      "remindByTenantIdAndPauseId",
      "noticeOnceByTenantIdAndPauseId",
      "claimNoticesDue",
      "ackNotice",
      "deleteByTenantIdAndThreadIdAndRunId",
      "markTakenByTenantIdAndPauseId",
      "findByTenantIdAndPauseId",
    ]);
    expect(heldMethodsOf(SqliteExecutionLeaseRepository)?.claimExecutionId?.point).toBe(
      StoreHoldPoint.LeaseClaimExecutionId,
    );
  });

  it("the fixture serves A2A only on a set that lists an A2A task store", () => {
    expect(keepsA2ATasks([SqliteExecutionLeaseRepository, SqliteA2ATaskRepository])).toBe(true);
    expect(keepsA2ATasks([SqliteExecutionLeaseRepository])).toBe(false);
  });
});
