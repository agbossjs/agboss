/**
 * #928 AC1 lease scopes — lease-held work outside a step frame is bounded by its lease: an
 * unanswered call there hands the tree over (abandon: nothing released, the next holder
 * reconciles). The cleanup after it and the checkpoint's renewal are in the sibling files.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { reportHeldOperations } from "../../src/testing/faults/held-stores.js";
import { OperationPhase } from "../../src/testing/faults/operation-history.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { passLive } from "../helpers/live-time.js";
import { UndoDesk, UndoDeskError } from "../flow/runtime/fixtures/undo.workflow.js";
import {
  AskGuestTool,
  GuestAgent,
  UnwindGuestWorkflowStart,
} from "../flow/runtime/fixtures/unwind-pause.workflow.js";
import {
  unwindSeen,
  UnwindGate,
  UnwindWorkflowStart,
} from "../flow/runtime/fixtures/unwind.workflow.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import { bothReady, item, leaseRowOf } from "./fixtures/finished-work.js";
import {
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";
import {
  callsOf,
  hangNext,
  hung,
  LeaseScopeBoundApplication,
} from "./fixtures/lease-scope-bound.application.js";
import {
  GUEST,
  ready,
  releaseHolds,
  resetScopeBound,
  rootOf,
  THREAD,
} from "./fixtures/lease-scope-bound.helpers.js";

const two = testWith(LeaseScopeBoundApplication, { instances: 2 });

let stop: () => void = () => undefined;

beforeEach(resetScopeBound);

afterEach(() => {
  stop();
  releaseHolds();
});

describe("#928 AC1 lease scopes: #drain", () => {
  two(
    "#drain: the terminal record's completion held for ever hands over; forgetTree does not run; @agboss/unwinding is kept and the remaining compensations run on the next holder",
    async ({ apps, clock, mockOf }) => {
      const desk = mockOf(UndoDesk);
      desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
      mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));
      const [a, b] = await ready(apps);
      hangNext("records.complete");
      const failure = rejectionOf(execute(a, UnwindWorkflowStart, GUEST, THREAD));
      await until(() => callsOf("records.complete") > 0, "the record's completion is held");
      expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);

      await passLive(clock, seconds(40));
      const error = await failure;

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(callsOf("trees.deleteAllInTree")).toBe(0);
      expect(unwindSeen.errors).toEqual([]);
      expect(await rootOf(b)).toEqual({ status: "running", isUnwinding: true });

      await passLive(clock, seconds(60));
      await until(() => unwindSeen.errors.length === 1, "the next holder ends the tree");

      expect(await rootOf(b)).toEqual({ status: "failed", isUnwinding: false });
      // the undos done are marked: the next holder runs none again
      expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
      expect(hung.left.get("records.complete")).toBe(0);
    },
  );
});

describe("#928 AC1 lease scopes: endedWithoutPass", () => {
  two(
    "endedWithoutPass: failedRecord held for ever hands over; no forgetTree",
    async ({ apps, clock, mockLlm, mockOf }) => {
      const desk = mockOf(UndoDesk);
      desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
      mockLlm(GuestAgent).thenReturn(callTool(AskGuestTool, GUEST));
      const [a, b] = await ready(apps);
      await execute(a, UnwindGuestWorkflowStart, GUEST, THREAD);
      hangNext("records.completeIfStatus.running");
      const cancelled = rejectionOf(a.cancel("t-1"));
      await until(() => callsOf("records.completeIfStatus.running") > 0, "failedRecord is held");

      await passLive(clock, seconds(40));
      const error = await cancelled;

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(callsOf("trees.deleteAllInTree")).toBe(0);
      expect(unwindSeen.errors).toEqual([]);
      expect(await rootOf(b)).toEqual({ status: "running", isUnwinding: true });
      expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1"]);

      await passLive(clock, seconds(60));
      await until(() => unwindSeen.errors.length === 1, "the next holder ends the tree");

      expect(await rootOf(b)).toEqual({ status: "failed", isUnwinding: false });
      expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1"]);
    },
  );
});

describe("#928 AC1 lease scopes: #executeClaimed", () => {
  two(
    "#executeClaimed: completeByTenantIdAndExecutionId held for ever: the child's lease is abandoned, not released while complete is in flight; the child is not run twice",
    async ({ apps, clock }) => {
      // the lease calls that end a child's lease, from the moment its completion is held
      const released: string[] = [];
      let isHeld = false;
      stop = reportHeldOperations({
        onOperation: (event) => {
          const isEnd = /^lease\.(release|retire)$/u.test(event.operation);
          if (isHeld && isEnd && event.phase === OperationPhase.Invoke)
            released.push(event.key ?? "");
        },
      });
      const [a] = await bothReady(apps);
      processHoldPoints.arm({ point: StoreHoldPoint.ChildComplete });
      let done: unknown;
      void execute(a, YieldOneWorkflowStart, item("pay"), THREAD).then((value) => (done = value));
      await until(() => processHoldPoints.held.length === 1, "the child's completion is held");
      isHeld = true;
      const child = processHoldPoints.held[0]?.key ?? "";
      expect(yieldSeen.runs.map((run) => run.name)).toEqual(["pay"]);

      await passLive(clock, seconds(40));

      // the child's lease is abandoned: nothing reached the store, its row is still the holder's
      expect(released).not.toContain(child);
      expect(leaseRowOf(a, child)?.released).toBe(false);
      expect(done).toBeUndefined();

      await passLive(clock, seconds(60));
      await until(() => done !== undefined, "the parent ends");

      expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "pay" });
      expect(yieldSeen.runs.map((run) => run.name)).toEqual(["pay"]);
    },
  );
});
