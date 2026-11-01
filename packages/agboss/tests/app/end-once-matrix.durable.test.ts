/**
 * #596 / #597 acceptance — the holder frozen right before or right after a write that makes an end
 * durable (a child's or the root's failed step's error, the root's finish checkpoint), another
 * instance recovering the tree, the old holder thawed before or after that one ended it. Every end is
 * heard at most once and never by the old holder; the root's end exactly once; a failure claimed
 * before the freeze is never followed by a finish.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import { heard, readyAll } from "./fixtures/child-end-freeze.js";
import { EndOnceLocalWorkflowStart, resetEndOnce } from "./fixtures/child-end-once.workflow.js";
import {
  SidePathLocalWorkflowStart,
  UndoLocalWorkflowStart,
} from "./fixtures/child-failure-once.workflow.js";
import { resetUndo, undoSeen, UndoOneWorkflowStart } from "./fixtures/finished-undo.workflow.js";
import { JoinUndoWorkflowStart, RootUndoWorkflowStart } from "./fixtures/join-undo.workflow.js";
import {
  atDurable,
  DurablePoint,
  EndOnceMatrixApplication,
  finishesSeen,
  resetMatrix,
  takeoversSeen,
} from "./fixtures/end-once-matrix.workflow.js";
import {
  openGate,
  resetYield,
  YieldOneWorkflowStart,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(EndOnceMatrixApplication, { instances: 2 });

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetUndo();
  resetMatrix();
  resetLogged();
});

type Start =
  | typeof EndOnceLocalWorkflowStart
  | typeof YieldOneWorkflowStart
  | typeof UndoLocalWorkflowStart
  | typeof UndoOneWorkflowStart
  | typeof SidePathLocalWorkflowStart
  | typeof RootUndoWorkflowStart
  | typeof JoinUndoWorkflowStart;

/** One window: where the holder freezes, the tree, and what it must end as. */
interface Window {
  readonly at: DurablePoint;
  readonly root: string;
  readonly start: Start;
  readonly input: ReturnType<typeof item>;
  /** The root's end: its finish, or `undefined` for a failure. */
  readonly finish: string | undefined;
  /** The child's: `end` (a finish), `error`, or `either` (its outcome is the new holder's). */
  readonly child: "end" | "error" | "either";
}

const ROOT_ENDS: readonly Window[] = [
  ...[DurablePoint.RootFinishBefore, DurablePoint.RootFinishAfter].flatMap((at) => [
    {
      at,
      root: "ParentInstance",
      start: EndOnceLocalWorkflowStart,
      input: item("gate"),
      finish: "end-once-local-workflow-finish",
      child: "end" as const,
    },
    {
      at,
      root: "AnyInstance",
      start: YieldOneWorkflowStart,
      input: item("gate"),
      finish: "yield-one-workflow-finish",
      child: "end" as const,
    },
    {
      at,
      root: "ParentInstance with an undo",
      start: UndoLocalWorkflowStart,
      input: item("gate"),
      finish: "undo-local-workflow-finish",
      child: "end" as const,
    },
    {
      at,
      root: "AnyInstance with an undo",
      start: UndoOneWorkflowStart,
      input: item("gate"),
      finish: "undo-one-workflow-finish",
      child: "end" as const,
    },
    // a side path took the claimed failure: the tree ends at the failed finish, never the checked one
    {
      at,
      root: "side path",
      start: SidePathLocalWorkflowStart,
      input: item("gate-flaky"),
      finish: "side-path-failed-workflow-finish",
      child: "error" as const,
    },
  ]),
  ...[DurablePoint.RootErrorBefore, DurablePoint.RootErrorAfter].flatMap((at) => [
    {
      at,
      root: "ParentInstance",
      start: EndOnceLocalWorkflowStart,
      input: item("gate", "fail"),
      finish: undefined,
      child: "error" as const,
    },
    // the child's failure claimed before the freeze: the step that would now pass is not run again
    {
      at,
      root: "ParentInstance, first run only",
      start: EndOnceLocalWorkflowStart,
      input: item("gate-flaky"),
      finish: undefined,
      child: "error" as const,
    },
    {
      at,
      root: "AnyInstance",
      start: YieldOneWorkflowStart,
      input: item("gate", "fail"),
      finish: undefined,
      child: "error" as const,
    },
    {
      at,
      root: "AnyInstance, first run only",
      start: YieldOneWorkflowStart,
      input: item("gate-flaky"),
      finish: undefined,
      child: "error" as const,
    },
    {
      at,
      root: "ParentInstance with an undo",
      start: UndoLocalWorkflowStart,
      input: item("gate", "fail"),
      finish: undefined,
      child: "error" as const,
    },
    {
      at,
      root: "AnyInstance with an undo",
      start: UndoOneWorkflowStart,
      input: item("gate", "fail"),
      finish: undefined,
      child: "error" as const,
    },
  ]),
];

const CHILD_ENDS: readonly Window[] = [
  // nothing durable, nothing announced: the new holder runs the step again — its outcome is the tree's
  {
    at: DurablePoint.ChildErrorBefore,
    root: "ParentInstance",
    start: EndOnceLocalWorkflowStart,
    input: item("gate", "fail"),
    finish: undefined,
    child: "error",
  },
  {
    at: DurablePoint.ChildErrorBefore,
    root: "ParentInstance, first run only",
    start: EndOnceLocalWorkflowStart,
    input: item("gate-flaky"),
    finish: "end-once-local-workflow-finish",
    child: "end",
  },
  // durable but not claimed (#596's window): the new holder runs it again, claims what it sees
  {
    at: DurablePoint.ChildErrorAfter,
    root: "ParentInstance, first run only",
    start: EndOnceLocalWorkflowStart,
    input: item("gate-flaky"),
    finish: "end-once-local-workflow-finish",
    child: "end",
  },
];

/**
 * #605: an undo is never run by a holder that lost the tree. Frozen right before its child's failed
 * step's error is written, thawed after the takeover, the old holder's step went on to undo the
 * child a second time (the root's and a join's: `undo-fence.test.ts`).
 */
const UNDOS: readonly Window[] = [
  {
    at: DurablePoint.ChildErrorBefore,
    root: "ParentInstance with an undo (#605)",
    start: UndoLocalWorkflowStart,
    input: item("gate", "fail"),
    finish: undefined,
    child: "error",
  },
  {
    at: DurablePoint.ChildErrorBefore,
    root: "ParentInstance with an undo, first run only (#605)",
    start: UndoLocalWorkflowStart,
    input: item("gate-flaky"),
    finish: "undo-local-workflow-finish",
    child: "end",
  },
  {
    at: DurablePoint.RootErrorBefore,
    root: "a root's own undo (#605)",
    start: RootUndoWorkflowStart,
    input: item("gate", "fail"),
    finish: undefined,
    child: "either",
  },
  // #607: the join undid the booking, then its holder froze before the failure was durable — the
  // new holder runs the launch's superstep again and finds the booking's undo marked done
  ...[DurablePoint.RootErrorBefore, DurablePoint.RootErrorAfter].map((at) => ({
    at,
    root: "a failed join's undo (#607)",
    start: JoinUndoWorkflowStart,
    input: item("gate", "fail"),
    finish: undefined,
    child: "either" as const,
  })),
];

/** Advances live time in steps of 10 s until `done`, at most `steps` times. */
async function liveUntil(clock: VirtualClock, done: () => boolean, steps: number): Promise<void> {
  for (let step = 0; step < steps && !done(); step += 1) await clock.advance(seconds(10));
}

const rootEnded = (): boolean => heard().rootEnds.length + heard().rootErrors.length > 0;

describe("#596/#597 acceptance: the holder freezes around a write that makes an end durable", () => {
  for (const window of [...ROOT_ENDS, ...CHILD_ENDS, ...UNDOS])
    for (const thaws of [
      "right after the takeover",
      "after the new holder ended the tree",
    ] as const)
      test(`${window.at} — ${window.root}, thawed ${thaws}: every end once at most, the root's once, never by the frozen one, no undo twice`, async ({
        apps,
        clock,
        leases,
      }) => {
        const [a] = apps;
        if (a === undefined) throw new Error("two instances");
        const byId = await readyAll(apps);
        let thaw = (): void => undefined;
        const thawed = new Promise<void>((resolve) => {
          thaw = resolve;
        });
        let frozen: string | undefined;
        atDurable(window.at, async (index) => {
          const app = apps[index];
          frozen = [...byId].find(([, each]) => each === app)?.[0] ?? "unknown";
          if (app !== undefined) leases.stall(app);
          await thawed;
        });
        const call = rejectionOf(execute(a, window.start, window.input, { threadId: "thread-d" }));
        openGate();
        await until(() => frozen !== undefined, `frozen at ${window.at}`);
        // another instance took the frozen one's lease over (a re-acquire of its own is no takeover here)
        const isTakenOver = (): boolean =>
          takeoversSeen.some((each) => each.previous === frozen && each.holder !== frozen);
        await liveUntil(clock, isTakenOver, 12);
        expect(isTakenOver()).toBe(true);
        if (thaws === "right after the takeover") thaw();
        await liveUntil(clock, rootEnded, 12);
        await until(rootEnded, "the tree ended where it was taken over");
        thaw();
        await settle();
        for (const each of apps) leases.resume(each);
        const error = await call;
        await liveUntil(clock, () => false, 2);
        await settle();

        const seen = heard();
        const roots = [...seen.rootEnds, ...seen.rootErrors];
        expect(roots).toHaveLength(1);
        expect(roots.filter((each) => each.instanceId === frozen)).toEqual([]);
        if (frozen === "instance-2") expect(error).toBeInstanceOf(ExecutionLeaseLostError);
        expect(seen.rootErrors).toHaveLength(window.finish === undefined ? 1 : 0);
        expect(finishesSeen.map((each) => each.finish)).toEqual(
          window.finish === undefined ? [] : [window.finish],
        );
        expect(seen.childEnds.length + seen.childErrors.length).toBeLessThanOrEqual(1);
        if (window.child === "end") expect(seen.childErrors).toEqual([]);
        if (window.child === "error") expect(seen.childEnds).toEqual([]);
        // no-undo-on-hand-over: an undo runs once, never again by a holder that lost the tree
        expect(undoSeen.booked.length).toBeLessThanOrEqual(1);
        expect(undoSeen.cancelled.length).toBeLessThanOrEqual(1);
        // a tree that finished keeps what it booked: no holder undoes it, a lost one neither (#605)
        if (window.child === "end") expect(undoSeen.cancelled).toEqual([]);
      });
});
