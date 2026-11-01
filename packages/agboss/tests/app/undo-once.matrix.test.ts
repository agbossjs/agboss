/**
 * #607 — every automatic undo is durable once across takeovers. The holder of an undo freezes at one
 * of four points (in the undo action before or after its refund, before or once its done mark is
 * written), another instance takes the tree over and finishes it — and in a double takeover freezes
 * at the same point of the same undo too, so a third instance does —, then the frozen ones thaw
 * right after the takeover or after the tree ended. Each booking is refunded exactly once (the
 * refund a fenced effect keyed by the undo's step key, so a zombie is refused and a re-run is a
 * replay), an undo marked done never runs again, the root ends once, never by a frozen holder.
 */
import { beforeAll, beforeEach, describe, expect } from "vitest";
import { CompensationStatus, ExecutionHistoryRepository } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import { readyAll } from "./fixtures/child-end-freeze.js";
import { openGate, resetYield, yieldSeen } from "./fixtures/remote-child-yield.workflow.js";
import { atUndo, resetUndoOnce, undoOnceSeen, UndoPoint } from "./fixtures/undo-once.actions.js";
import {
  OnceAnyWorkflowStart,
  OnceBudgetWorkflowStart,
  OnceJoinSideWorkflowStart,
  OnceJoinWorkflowStart,
  OnceLevelWorkflowStart,
  OnceLocalWorkflowStart,
  OnceRootWorkflowStart,
  UndoOnceApplication,
} from "./fixtures/undo-once.workflow.js";

const test = testWith(UndoOnceApplication, { instances: 3 });

/**
 * The modules the framework loads lazily on these paths (a takeover of an unwinding tree, an
 * undo), loaded once before the matrix: a first load is real I/O the virtual clock does not wait
 * for, so on a loaded machine the first takeover could be raced past by virtual time.
 */
beforeAll(async () => {
  await Promise.all([
    import("../../src/app/unwinding-takeover.js"),
    import("../../src/app/cancel-requests.js"),
    import("../../src/app/cancel-thread.js"),
    import("../../src/app/compensation/root-unwind.js"),
    import("../../src/flow/runtime/compensation/child-unwind.js"),
    import("../../src/flow/runtime/compensation/join-unwind.js"),
    import("../../src/flow/runtime/compensation/unwinding-marks.js"),
    import("../../src/flow/runtime/compensation/visit-entries.js"),
  ]);
});

beforeEach(() => {
  resetYield();
  resetUndoOnce();
  resetLogged();
});

/** One tree: how it starts, how many bookings its end undoes, the error it ends with. */
interface UndoCase {
  readonly undo: string;
  readonly start:
    | typeof OnceRootWorkflowStart
    | typeof OnceJoinWorkflowStart
    | typeof OnceJoinSideWorkflowStart
    | typeof OnceLocalWorkflowStart
    | typeof OnceAnyWorkflowStart
    | typeof OnceBudgetWorkflowStart
    | typeof OnceLevelWorkflowStart;
  readonly name: string;
  readonly undos: number;
  /** The undos of the root's own bookings (a child's are listed by the child). */
  readonly rootUndos: number;
  /** `undefined`: it ends at a finish (a side path took the failure). */
  readonly error: string | undefined;
  /** Cancelled at its gate instead of failing. */
  readonly isCancelled?: boolean;
}

const CASES: readonly UndoCase[] = [
  {
    undo: "a failed join's undo",
    start: OnceJoinWorkflowStart,
    name: "join",
    undos: 1,
    rootUndos: 1,
    error: "ActionFailedError",
  },
  {
    undo: "a failed join's undo, then its side path to a finish",
    start: OnceJoinSideWorkflowStart,
    name: "join-side",
    undos: 1,
    rootUndos: 1,
    error: undefined,
  },
  {
    undo: "a failed root's undo",
    start: OnceRootWorkflowStart,
    name: "root",
    undos: 1,
    rootUndos: 1,
    error: "ActionFailedError",
  },
  {
    undo: "a cancelled root's undo",
    start: OnceRootWorkflowStart,
    name: "gate-cancel",
    undos: 1,
    rootUndos: 1,
    error: "ExecutionCancelledError",
    isCancelled: true,
  },
  {
    undo: "the undo of a root out of budget",
    start: OnceBudgetWorkflowStart,
    name: "budget",
    undos: 1,
    rootUndos: 1,
    error: "BudgetExceededError",
  },
  {
    undo: "a ParentInstance child's undo",
    start: OnceLocalWorkflowStart,
    name: "local",
    undos: 1,
    rootUndos: 0,
    error: "ChildExecutionFailedError",
  },
  {
    undo: "an AnyInstance child's undo",
    start: OnceAnyWorkflowStart,
    name: "any",
    undos: 1,
    rootUndos: 0,
    error: "ChildExecutionFailedError",
  },
  {
    undo: "a recursion level's undo, then its root's",
    start: OnceLevelWorkflowStart,
    name: "level",
    undos: 2,
    rootUndos: 1,
    error: "ChildExecutionFailedError",
  },
];

/** Advances live time in steps of 10 s until `done`, at most `steps` times. */
async function liveUntil(clock: VirtualClock, done: () => boolean, steps: number): Promise<void> {
  for (let step = 0; step < steps && !done(); step += 1) {
    await clock.advance(seconds(10));
    // the work a step woke that the clock does not track (a sweep's reads) goes on before the next
    // step, however loaded the machine: a takeover is never raced past by virtual time
    await settle();
  }
}

const isTakenOverFrom = (instanceId: string | undefined): boolean =>
  undoOnceSeen.takeovers.some((each) => each.previous === instanceId && each.holder !== instanceId);

const rootEnded = (): boolean => undoOnceSeen.roots.length > 0;

/**
 * Starts the case's tree on `a`; a cancelled one is cancelled once its gate holds it. Its call, in an
 * object (an awaited promise would wait for it).
 */
async function started(a: TestApp, each: UndoCase): Promise<{ readonly call: Promise<unknown> }> {
  const call = rejectionOf(
    execute(a, each.start, item(each.name, "fail"), { threadId: "thread-o" }),
  );
  if (each.isCancelled !== true) return { call };
  await until(() => yieldSeen.runs.length === 1, "the root at its gate");
  void a.cancel("thread-o", { tenantId: "default" }).catch(() => undefined);
  return { call };
}

/** The instances frozen, in order, once each froze and was taken over. */
async function frozenAndTakenOver(
  clock: VirtualClock,
  frozen: readonly string[],
  freezes: number,
): Promise<void> {
  for (let index = 0; index < freezes; index += 1) {
    await liveUntil(clock, () => frozen.length > index || rootEnded(), 24);
    if (frozen.length <= index) return;
    await liveUntil(clock, () => isTakenOverFrom(frozen[index]), 24);
    expect(isTakenOverFrom(frozen[index])).toBe(true);
  }
}

/** The undos the root's kept record lists. */
async function keptUndosOf(a: TestApp): Promise<readonly string[]> {
  const history = a.resolve(ExecutionHistoryRepository);
  const [record] = await history.findAllByExecutionId("execution-1");
  return (record?.compensations ?? []).map((undo) => `${undo.compensated.nodeId} ${undo.status}`);
}

/** One case's run: its tree, where it froze, how often, and the instances frozen. */
interface FrozenRun {
  readonly each: UndoCase;
  readonly at: UndoPoint;
  readonly freezes: number;
  readonly frozen: readonly string[];
}

/**
 * Each booking refunded once and each undo recorded once; the undo action run again only for the
 * holders frozen before its done mark; the root ended once, never by a frozen holder.
 */
async function expectUndoneOnce(
  a: TestApp,
  { each, at, freezes, frozen }: FrozenRun,
): Promise<void> {
  // the done mark comes after the refund: frozen once it is written, nothing runs again
  const isMarked = at === UndoPoint.MarkAfter;
  expect(frozen).toHaveLength(isMarked ? 1 : freezes);
  const refunded = undoOnceSeen.refunds.map((refund) => refund.bookingId).sort();
  expect(undoOnceSeen.bookings).toHaveLength(each.undos);
  expect(refunded).toEqual([...undoOnceSeen.bookings].sort());
  expect(undoOnceSeen.undos).toHaveLength(each.undos + (isMarked ? 0 : frozen.length));
  // a holder frozen before its refund never refunds: its thawed write is fenced
  const byFrozen = undoOnceSeen.refunds.filter((refund) => frozen.includes(refund.instanceId));
  if (at === UndoPoint.ActionBefore) expect(byFrozen).toEqual([]);
  expect(undoOnceSeen.roots).toHaveLength(1);
  expect(undoOnceSeen.roots[0]?.error).toBe(each.error);
  expect(frozen).not.toContain(undoOnceSeen.roots[0]?.instanceId);
  // the root's own undos listed once each, done (a child's are its own); after a finish, in the
  // root's kept record: the finish committed nothing undone
  const done = Array.from({ length: each.rootUndos }, () => "paid-booking-action compensated");
  if (each.error !== undefined) expect(undoOnceSeen.roots[0]?.undone).toEqual(done);
  else expect(await keptUndosOf(a)).toEqual(done);
}

describe("#607: every automatic undo runs to effect once across takeovers", () => {
  for (const each of CASES)
    for (const at of Object.values(UndoPoint))
      for (const freezes of [1, 2])
        for (const thaws of ["right after the takeover", "after the tree ended"] as const)
          test(`${each.undo}, its holder frozen ${at}, ${freezes === 1 ? "one takeover" : "two takeovers"}, thawed ${thaws}: refunded once, a done undo never again`, async ({
            apps,
            clock,
            leases,
          }) => {
            const [a] = apps;
            if (a === undefined) throw new Error("three instances");
            const byId = await readyAll(apps);
            const frozen: string[] = [];
            let thaw = (): void => undefined;
            const thawed = new Promise<void>((resolve) => {
              thaw = resolve;
            });
            atUndo(at, freezes, async (instanceId) => {
              frozen.push(instanceId);
              const app = byId.get(instanceId);
              if (app !== undefined) leases.stall(app);
              await thawed;
            });
            if (each.isCancelled !== true) openGate();
            const { call } = await started(a, each);
            await until(() => frozen.length > 0, `frozen ${at}`);
            await frozenAndTakenOver(clock, frozen, freezes);
            if (thaws === "right after the takeover") thaw();
            await liveUntil(clock, rootEnded, 12);
            await until(rootEnded, "the tree ended where it was taken over");
            thaw();
            openGate();
            await settle();
            for (const app of apps) leases.resume(app);
            await call;
            await liveUntil(clock, () => false, 3);
            await settle();

            await expectUndoneOnce(a, { each, at, freezes, frozen });
          });
});
