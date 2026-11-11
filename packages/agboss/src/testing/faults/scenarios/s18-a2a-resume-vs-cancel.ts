import { EXECUTION_LEASE } from "../../../app/lease-fence.js";
import { systemClock, waitOf } from "../../../infrastructure/clock.js";
import { HoldPhase } from "../hold-points.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { a2aCall, a2aCallInFlight, a2aPod, approval, FaultSkill, orderMessage } from "./a2a-kit.js";
import { FaultStepPoint } from "../fixture/pod-link.js";
import { expectThat, heldAt, heldStep, holdStep, holdStore, release } from "./kit.js";
import {
  canceledOnBoth,
  isAccepted,
  isCanceled,
  isResumedFirst,
  isStoppedWithin,
  movedBy,
  pausedTask,
  raced,
  transitionsOf,
} from "./s18-kit.js";

/**
 * Scenario 18 (#811 AC4, design §4.3.2 "Resume racing cancel"): a task rests `INPUT_REQUIRED` at
 * its order's approval; a follow-up that approves it reaches pod a and a `CancelTask` pod b, and
 * each order is forced by a hold on a:
 * - 18, resume first, its pass running: a's resumed pass is held at the charge step (before any
 *   effect); b's cancel finds the pause taken and requests the tree's cancel, and a's pass stops at
 *   its next renewal — undone once, nothing charged or paid, `CANCELED`. A pass the cancel never
 *   stops is let go after two leases: what it commits then is the invariant's to judge;
 * - 18b, cancel first: a's resume is held at its read of the pause, before it marks the root
 *   running (#850) or resolves the pause; b withdraws the pause and ends the task `CANCELED`; a's
 *   resume finds it no longer pending, `-32004`, and nothing moves;
 * - 18c, resume first, its pass not begun: a's resume is held after its resolve (the store
 *   answered; the root is `running` again since its mark, #850); b's cancel finds it running and
 *   requests the tree's cancel; the resume is let go two leases later, and whichever pass takes the
 *   tree (a's, or a recovery's) reads the request and moves nothing. A tree that never reads it
 *   commits more than a lease after its cancel request: the invariant's to judge.
 * - 18d, resume while the first pass still holds the tree (#901): a's first pass is held after its
 *   `INPUT_REQUIRED` write (its rest announced, its lease still held); the follow-up's resume on b
 *   records its answer and waits for the lease; a's drain takes that answer and is held after its
 *   `WORKING` write (the answered pass announced, not begun); b's cancel finds the tree running and
 *   requests its cancel; a's next background renewal reads it before the drain's pass moves, so
 *   that pass stops before it stores a step (its checkpoint still at the pause); the tree ends
 *   `CANCELED` and its keys go — the request with them —, and a dies before the end marks the
 *   answer `Taken`. b's resume then takes the lease: the answer `Resolved`, the first rest's paused
 *   run stored, no request — it reads the root's failed record and moves nothing (`-32004`).
 * Never both resumed with effects and canceled (`a2a-tasks-once`).
 */

export const s18ResumeFirst: RunnableFaultScenario = {
  id: "s18-a2a-resume-vs-cancel",
  title:
    "18: an A2A task's resume takes its pause first and its pass runs; a cancel on another pod aborts the pass before its charge — undone once, CANCELED, nothing charged",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a");
    const b = await a2aPod(cluster, "b");
    const taskId = await pausedTask(cluster, a, "o-18");
    await holdStep(a, FaultStepPoint.ChargeBefore, "o-18");
    const resume = a2aCallInFlight(cluster, a, "SendMessage", approval("m-o-18-yes", taskId));
    // the decision taken, the resumed pass at the charge: the cancel lands on a running pass
    const charge = await heldStep(cluster, a, FaultStepPoint.ChargeBefore, "o-18");
    const cancel = await a2aCall(cluster, b, "CancelTask", { id: taskId });
    expectThat(cluster, isAccepted(cancel), `the cancel was refused: ${JSON.stringify(cancel)}`);
    expectThat(
      cluster,
      isResumedFirst(cluster, a, b),
      `the resume was to win: ${transitionsOf(cluster, a, b)}`,
    );
    // the pass reads its tree's cancel request at its next renewal: the held step stops there
    if (!(await isStoppedWithin(cluster, a, "o-18"))) {
      // never stopped: the charge goes on, and the invariant judges what it committed
      await release(a, charge);
      await cluster.ended(taskId);
      return b;
    }
    await cluster.ended(taskId);
    const resumed = await resume;
    expectThat(
      cluster,
      resumed.errorCode === undefined,
      `the resume, taken, was refused: ${JSON.stringify(resumed)}`,
    );
    await canceledOnBoth(cluster, [a, b], taskId);
    return b;
  },
};

export const s18bCancelFirst: RunnableFaultScenario = {
  id: "s18b-a2a-cancel-vs-resume",
  title:
    "18b: an A2A task's cancel withdraws its pause first, the resume on another pod comes after — -32004, CANCELED, nothing charged",
  run: async (cluster) => {
    const { a, b, taskId, resumed } = await raced(
      cluster,
      "o-18b",
      StoreHoldPoint.PauseFind,
      HoldPhase.Before,
    );
    const cancel = await a2aCall(cluster, b, "CancelTask", { id: taskId });
    expectThat(cluster, isCanceled(cancel), `b's cancel answered ${JSON.stringify(cancel)}`);
    const resume = await resumed();
    expectThat(
      cluster,
      resume.errorCode === -32004,
      `the resume after the cancel was to be -32004: ${JSON.stringify(resume)}`,
    );
    expectThat(
      cluster,
      movedBy(cluster, b, StoreHoldPoint.PauseCancel).includes(true) &&
        !movedBy(cluster, a, StoreHoldPoint.PauseResolve).includes(true),
      `the cancel was to withdraw the pause first: ${transitionsOf(cluster, a, b)}`,
    );
    await canceledOnBoth(cluster, [a, b], taskId);
    return b;
  },
};

export const s18cResumedNotRun: RunnableFaultScenario = {
  id: "s18c-a2a-resumed-cancel-before-pass",
  title:
    "18c: an A2A task's resume takes its pause, frozen before its pass; a cancel on another pod finds it running and requests its cancel — the tree runs nothing more, CANCELED",
  run: async (cluster) => {
    const { a, b, taskId, resumed } = await raced(
      cluster,
      "o-18c",
      StoreHoldPoint.PauseResolve,
      HoldPhase.After,
    );
    const cancel = await a2aCall(cluster, b, "CancelTask", { id: taskId });
    expectThat(
      cluster,
      isResumedFirst(cluster, a, b),
      `the resume was to win: ${transitionsOf(cluster, a, b)}`,
    );
    expectThat(cluster, isAccepted(cancel), `the cancel was refused: ${JSON.stringify(cancel)}`);
    // the answer was taken, the cancel requested: the pass that takes the tree reads it first
    await systemClock.sleep(waitOf((2 * EXECUTION_LEASE) / cluster.options.timeScale));
    const resume = await resumed();
    expectThat(
      cluster,
      resume.errorCode === undefined || resume.errorCode === -32004,
      `the resume after the cancel request answered ${JSON.stringify(resume)}`,
    );
    await cluster.ended(taskId);
    const ended = await a2aCall(cluster, a, "GetTask", { id: taskId });
    if (!isCanceled(ended)) {
      // the request never read: the invariant judges what the tree committed after it
      expectThat(
        cluster,
        false,
        `the task ended ${JSON.stringify(ended)} after its cancel request`,
      );
      return b;
    }
    await canceledOnBoth(cluster, [a, b], taskId);
    return b;
  },
};

export const s18dDrainTookAnswer: RunnableFaultScenario = {
  id: "s18d-a2a-drain-took-answer-cancel",
  title:
    "18d: an A2A task answered while its first pass still holds it; the drain takes the answer, a cancel stops that pass and its pod dies before the answer is marked taken — the waiting resume runs nothing, -32004, CANCELED",
  run: async (cluster) => {
    const a = await a2aPod(cluster, "a");
    const b = await a2aPod(cluster, "b");
    const { A2ATaskStatusWrite, LeaseRenew, PauseMarkTaken, PauseResolve } = StoreHoldPoint;
    // a's status writes, each held once it is durable: the start's WORKING, the rest's
    // INPUT_REQUIRED, the drained pass's WORKING
    await holdStore(a, A2ATaskStatusWrite, undefined, { phase: HoldPhase.After, times: 3 });
    const order = orderMessage("m-o-18d", "o-18d", FaultSkill.Approval);
    const accepted = a2aCallInFlight(cluster, a, "SendMessage", order);
    await release(a, await heldAt(cluster, a, A2ATaskStatusWrite));
    const taskId = (await accepted).taskId ?? "";
    expectThat(cluster, taskId !== "", "the order's message got no task");
    // the rest written (a caller reads INPUT_REQUIRED), the first pass still holding the lease
    const rested = await heldAt(cluster, a, A2ATaskStatusWrite, taskId, 2);
    // the follow-up's resume on b records its answer, then waits for the lease a holds
    await holdStore(b, PauseResolve, undefined, { phase: HoldPhase.After });
    const resume = a2aCallInFlight(cluster, b, "SendMessage", approval("m-o-18d-yes", taskId));
    const resolved = await heldAt(cluster, b, PauseResolve);
    await release(b, resolved);
    await release(a, rested);
    // the drain took the answer: its pass is announced, not begun — the cancel lands before it moves
    const drained = await heldAt(cluster, a, A2ATaskStatusWrite, taskId, 3);
    const cancel = await a2aCall(cluster, b, "CancelTask", { id: taskId });
    expectThat(cluster, isAccepted(cancel), `the cancel was refused: ${JSON.stringify(cancel)}`);
    expectThat(
      cluster,
      movedBy(cluster, b, PauseResolve).includes(true),
      `the resume was to take the pause: ${transitionsOf(cluster, b, a)}`,
    );
    // a reads the request at its next background renewal, before the drain's pass moves (as in
    // #901's run): a renewal held, then the one after it — which comes only once the first's check,
    // the request's read, is done — so the pass starts on an aborted watch, no step stored
    await holdStore(a, LeaseRenew, taskId);
    const renewal = await heldAt(cluster, a, LeaseRenew, taskId);
    await holdStore(a, LeaseRenew, taskId);
    await release(a, renewal);
    await release(a, await heldAt(cluster, a, LeaseRenew, taskId, 2));
    // the pass stops, the tree ends: its record failed, CANCELED, its keys gone (the request
    // with them); a dies before the answer no step took is marked `Taken` (#890 marks it at the end)
    await holdStore(
      a,
      PauseMarkTaken,
      resolved.key === undefined ? undefined : String(resolved.key),
    );
    await release(a, drained);
    await heldAt(cluster, a, PauseMarkTaken);
    await a.kill();
    // b's resume takes the lease once a's expires: a `Resolved` answer, the first rest's paused run
    // and no cancel request — only the root's failed record tells it the tree is over
    const resumed = await resume;
    expectThat(
      cluster,
      resumed.errorCode === -32004,
      `the resume of the ended tree was to be -32004: ${JSON.stringify(resumed)}`,
    );
    const ended = await a2aCall(cluster, b, "GetTask", { id: taskId });
    expectThat(cluster, isCanceled(ended), `the task ended ${JSON.stringify(ended)}`);
    await canceledOnBoth(cluster, [b], taskId);
    return b;
  },
};
