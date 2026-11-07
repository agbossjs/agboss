/**
 * #810 AC5 (money) — an A2A call's charges across a takeover, end to end: the caller's step asks
 * the peer (price 1) and the peer's execution spends 3, so the call costs exactly 3 — the price
 * once and the verified run report's excess (2) once — whichever pass charges what. Instance A
 * holds the tree and dies (its lease frozen: a SIGKILL as the store sees it); instance B's
 * recovery sweep takes the tree over and runs the step again: its accept is the one A recorded
 * (`OutboundCallOutcomeStatus.Replayed` — nothing sent again), it waits on the same task and
 * settles. The ledger's total for the execution is 3: never 1 (the excess missed on a replay), 4
 * (the price charged again) or 6 (both again).
 */
import "./fixtures/keys.js";
import { afterEach, beforeEach, describe, expect } from "vitest";
import type { TestApp, TestLeases } from "../../../src/testing/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { testWith } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { untilReached } from "../../helpers/reached.js";
import { instance, rejectionOf, settle } from "../../app/fixtures/fence-takeover.js";
import {
  caller,
  CallerApplication,
  CallerWorkflowStart,
  PRICE,
  resetCaller,
} from "./fixtures/caller/caller.application.js";
import { A2AProtocolError } from "../../../src/a2a/index.js";
import { HopsLimitExceededError } from "../../../src/index.js";
import { peer, resetPeer, StrictPeerApplication } from "./fixtures/peer/peer.application.js";
import { executionSpentOf, servePeer, type ServedPeer } from "./fixtures/serve-peer.js";

const two = testWith(CallerApplication, { instances: 2, allowNetwork: ["127.0.0.1"] });

const served: ServedPeer[] = [];

beforeEach(() => {
  resetCaller();
  resetPeer();
});

afterEach(async () => {
  for (const letGo of caller.frozen.splice(0)) letGo();
  await Promise.all(served.splice(0).map((one) => one.close()));
});

/** The one root execution of the test. */
const ROOT = "execution-1";

/** A held gate: the peer's answer waits at it until `open()`. */
function heldGate(): { readonly open: () => void } {
  let open = (): void => undefined;
  peer.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    open: () => {
      open();
    },
  };
}

/** A's lease frozen, the clock past it twice: B's sweep takes the tree over and runs the step again. */
async function takenOverByB(clock: VirtualClock, leases: TestLeases, a: TestApp): Promise<void> {
  leases.freeze(a);
  await clock.advance(seconds(31));
  await clock.advance(seconds(31));
  await settle();
}

/**
 * Both instances up, the peer served, A's call started. The peer's clock is one of its own at the
 * test's start, never moved: the caller's clock jumps past its lease, the peer's execution — alive
 * on its own process — must not see that as its own holder's death.
 */
async function started(
  apps: readonly TestApp[],
  Peer?: typeof StrictPeerApplication,
): Promise<{ readonly a: TestApp; readonly b: TestApp; readonly call: Promise<unknown> }> {
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  served.push(await servePeer(new VirtualClock(), Peer));
  const call = execute(a, CallerWorkflowStart, { text: "is invoice 7 paid?" });
  call.catch(() => undefined);
  return { a, b, call };
}

describe("#810 AC5: a takeover that replays the accept charges price + report excess exactly once", () => {
  two(
    "AC5: A dies while it waits (price charged, task working) → B replays the accept, waits, settles: 3",
    async ({ apps, clock, leases }) => {
      const gate = heldGate();
      const { a, b, call } = await started(apps);
      await untilReached(() => peer.runs.length === 1, "the peer's run");
      await settle();
      // pass 1 charged the price at the accept, before its wait
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(1);

      await takenOverByB(clock, leases, a);
      gate.open();
      await untilReached(() => caller.ends.length === 1, "the recovered execution's end");
      await settle();

      expect(caller.sends).toHaveLength(1); // B replayed the accept: nothing sent again
      expect(peer.runs).toHaveLength(1); // one remote execution
      expect(caller.ends[0]?.spend.totalUsd).toBeCloseTo(3);
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(3);
      // A, a zombie that also heard the task end and settled it: still 3
      leases.thaw(a);
      await settle();
      expect(await rejectionOf(call)).toBeDefined();
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(3);
    },
    30_000,
  );

  two(
    "AC5: A dies after the task settled and its excess was charged, before the step was durable → B replays and settles again: 3",
    async ({ apps, clock, leases }) => {
      caller.freezeAfterCall = 1;
      const { a, b } = await started(apps);
      await untilReached(() => caller.frozen.length === 1, "A frozen after its call");
      await settle();
      // pass 1 charged everything: the price and the report's excess
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(3);

      await takenOverByB(clock, leases, a);
      await untilReached(() => caller.ends.length === 1, "the recovered execution's end");
      await settle();

      // a later pass got the answer again, from the accept A recorded
      expect(caller.answers.length).toBeGreaterThanOrEqual(2);
      expect(caller.sends).toHaveLength(1);
      expect(peer.runs).toHaveLength(1);
      expect(caller.ends[0]?.spend.totalUsd).toBeCloseTo(3);
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(3);
    },
    30_000,
  );

  two(
    "AC5: A and B both settle the same ended task at once (a zombie beside the new holder): 3",
    async ({ apps, clock, leases }) => {
      const gate = heldGate();
      const { a, b } = await started(apps);
      await untilReached(() => peer.runs.length === 1, "the peer's run");
      await settle();
      await takenOverByB(clock, leases, a);
      // A, frozen, still has its wait open beside B's: the task's end reaches both, and each
      // settles it — A's charge is no lease store write, nothing stops it
      gate.open();
      await untilReached(() => caller.ends.length === 1, "the execution's end");
      await settle();
      // A's pass heard the end as well as B's (a recovered pass may have run the step twice)
      expect(caller.answers.length).toBeGreaterThanOrEqual(2);
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(3);
      leases.thaw(a);
      await settle();

      expect(peer.runs).toHaveLength(1);
      expect(caller.ends[0]?.spend.totalUsd).toBeCloseTo(3);
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(3);
    },
    30_000,
  );
});

describe("#849: a call the peer REJECTED charges nothing, a takeover's replay of the accept neither", () => {
  two(
    "A's call is refused (past the peer's maxMeshHops), A dies before the failure is durable → B replays the accept: 0",
    async ({ apps, clock, leases }) => {
      caller.freezeAfterError = 1;
      const { a, b, call } = await started(apps, StrictPeerApplication);
      await untilReached(() => caller.frozen.length === 1, "A frozen after its refused call");
      await settle();
      expect(caller.callErrors[0]).toBeInstanceOf(HopsLimitExceededError);
      // pass 1 charged nothing: the peer refused before anything ran
      expect(await executionSpentOf(b, ROOT)).toBe(0);

      await takenOverByB(clock, leases, a);
      await untilReached(
        () => caller.callErrors.slice(1).some((error) => error instanceof HopsLimitExceededError),
        "B's replayed call refused",
      );
      await settle();

      expect(caller.sends).toHaveLength(1); // B replayed the accept: nothing sent again
      expect(peer.runs).toEqual([]); // nothing ran at the peer
      // B's pass heard the same refusal from the accept A recorded (a fenced write may come first)
      expect(
        caller.callErrors.slice(1).some((error) => error instanceof HopsLimitExceededError),
      ).toBe(true);
      expect(await executionSpentOf(b, ROOT)).toBe(0);
      leases.thaw(a);
      for (const letGo of caller.frozen.splice(0)) letGo();
      await settle();
      expect(await rejectionOf(call)).toBeDefined();
      expect(await executionSpentOf(b, ROOT)).toBe(0);
    },
    30_000,
  );

  two(
    "a stored refusal the peer now contradicts (its task COMPLETED) on B's replay: charged the price, no output",
    async ({ apps, clock, leases }) => {
      caller.freezeAfterError = 1;
      const { a, b } = await started(apps, StrictPeerApplication);
      await untilReached(() => caller.frozen.length === 1, "A frozen after its refused call");
      await settle();
      expect(await executionSpentOf(b, ROOT)).toBe(0);

      caller.isGetTaskCompleted = true; // the peer lies from now on
      await takenOverByB(clock, leases, a);
      await untilReached(
        () => caller.callErrors.some((error) => error instanceof A2AProtocolError),
        "B's replay finds the refusal contradicted",
      );
      await settle();

      expect(caller.sends).toHaveLength(1); // B replayed the accept: nothing sent again
      expect(caller.answers).toEqual([]);
      expect(await executionSpentOf(b, ROOT)).toBeCloseTo(PRICE);
    },
    30_000,
  );
});
