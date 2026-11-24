/**
 * #844 (money) — a mesh call whose remote task completed by read repair: the peer's end event is
 * lost (its projection's write of COMPLETED fails, as an at-most-once observer event may), so the
 * task is completed from the peer's durable records. The repaired task still carries what the
 * execution spent, so its trusted caller gets the signed run report and is charged it: the price 1
 * and the report's 3 → 3, never the price alone, and exactly once across passes.
 */
import "./fixtures/keys.js";
import { afterEach, beforeEach, describe, expect } from "vitest";
import type { TestApp, TestLeases } from "../../../src/testing/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { testWith } from "../../../src/testing/index.js";
import {
  A2ATaskRepository,
  A2ATaskState,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { untilReached } from "../../helpers/reached.js";
import { instance, settle } from "../../app/fixtures/fence-takeover.js";
import {
  caller,
  CallerApplication,
  CallerWorkflowStart,
  resetCaller,
} from "./fixtures/caller/caller.application.js";
import {
  EndLosingPeerApplication,
  lossy,
  peer,
  resetPeer,
} from "./fixtures/peer/peer.application.js";
import { executionSpentOf, servePeer, type ServedPeer } from "./fixtures/serve-peer.js";

const one = testWith(CallerApplication, { allowNetwork: ["127.0.0.1"] });
const two = testWith(CallerApplication, { instances: 2, allowNetwork: ["127.0.0.1"] });

const served: ServedPeer[] = [];

beforeEach(() => {
  resetCaller();
  resetPeer();
});

afterEach(async () => {
  for (const letGo of caller.frozen.splice(0)) letGo();
  await Promise.all(served.splice(0).map((each) => each.close()));
});

/** The peer's one task, as its store keeps it. */
async function peerTaskOf(served: ServedPeer) {
  const page = await served.app
    .resolve(A2ATaskRepository)
    .list({ tenantId: "default", ownerId: "caller-application", pageSize: 10 });
  expect(page.tasks).toHaveLength(1);
  return page.tasks[0];
}

describe("#844: a task completed by read repair is charged its run report", () => {
  one(
    "AC2: the end event lost, the task repaired from the records — price 1, report 3 → charged 3",
    async ({ app }) => {
      lossy.endsToLose = 1;
      const peerClock = new VirtualClock();
      const served1 = await servePeer(peerClock, EndLosingPeerApplication);
      served.push(served1);

      const call = execute(app, CallerWorkflowStart, { text: "is invoice 7 paid?" });
      await untilReached(() => lossy.lost === 1, "the peer's end event lost");
      // a reader that came after the run ended here repairs it once a lease period passed
      await peerClock.advance(seconds(31));
      const result = await call;

      expect(lossy.lost).toBe(1); // the projection's end was lost: read repair completed it
      expect(await peerTaskOf(served1)).toMatchObject({
        status: { state: A2ATaskState.Completed, spentUsd: 3 },
      });
      expect(peer.runs).toHaveLength(1);
      expect(result.spend.totalUsd).toBeCloseTo(3);
      expect(await executionSpentOf(app, result.executionId)).toBeCloseTo(3);
    },
    30_000,
  );

  two(
    "AC2: the end lost and the caller taken over after it settled — B settles again: still 3, once",
    async ({ apps, clock, leases }) => {
      lossy.endsToLose = 1;
      caller.freezeAfterCall = 1;
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      // the peer on a clock of its own: the caller's jumps past its lease, the peer's must not
      const peerClock = new VirtualClock();
      served.push(await servePeer(peerClock, EndLosingPeerApplication));
      const call = execute(a, CallerWorkflowStart, { text: "is invoice 7 paid?" });
      call.catch(() => undefined);
      await untilReached(() => lossy.lost === 1, "the peer's end event lost");
      await settle();
      // a reader that came after the run ended here repairs it once a lease period passed
      await peerClock.advance(seconds(31));
      await untilReached(() => caller.frozen.length === 1, "A frozen after its call");
      await settle();
      expect(lossy.lost).toBe(1);
      expect(await executionSpentOf(b, "execution-1")).toBeCloseTo(3);

      await takenOver(clock, leases, a);
      await untilReached(() => caller.ends.length === 1, "the recovered execution's end");
      await settle();

      expect(caller.sends).toHaveLength(1);
      expect(peer.runs).toHaveLength(1);
      expect(caller.ends[0]?.spend.totalUsd).toBeCloseTo(3);
      expect(await executionSpentOf(b, "execution-1")).toBeCloseTo(3);
    },
    30_000,
  );
});

/** A's lease frozen, the clock past it twice: B's sweep takes the tree over. */
async function takenOver(clock: VirtualClock, leases: TestLeases, a: TestApp): Promise<void> {
  leases.freeze(a);
  await clock.advance(seconds(31));
  await clock.advance(seconds(31));
  await settle();
}
