/**
 * #720 — a claim the store made but whose answer never reached the worker (agbossjs/postgres: one
 * claim statement marked several rows `Running` for its instance and returned only the first) is
 * left `Running` with no lease. The parent's watch then has a worker reclaim it: the worker takes
 * the free lease, queues the row again and keeps the lease for its own next claim of the child.
 * When that claim is lost too, the kept lease had no pass behind it and was renewed for ever: every
 * other claimer was refused, the parent waited for ever (the 14-kubernetes-postgres-scaling run on
 * kind). A lease a reclaim keeps lives only through the reclaim's own look: a child that look did
 * not start gets its lease back, and the next reclaim or claim takes it like any other.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ChildExecutionQueueRepository, type QueuedChildExecution } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { settle } from "./fixtures/fence-takeover.js";
import { bothReady, databaseOf, item } from "./fixtures/finished-work.js";
import {
  RemoteChildYieldApplication,
  resetYield,
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(RemoteChildYieldApplication, { instances: 2 });

/**
 * The store's claims on `app` lose their answer `times` times: each claims the row in the store
 * (`Running`, this instance) and tells the worker nothing was claimed.
 */
function loseClaims(app: TestApp, times: number): { readonly lost: QueuedChildExecution[] } {
  const queue = app.resolve(ChildExecutionQueueRepository);
  const claim = queue.claimFirstByStatusQueuedOrderByDepthDesc.bind(queue);
  const lost: QueuedChildExecution[] = [];
  vi.spyOn(queue, "claimFirstByStatusQueuedOrderByDepthDesc").mockImplementation(async () => {
    const claimed = await claim();
    if (claimed === undefined || lost.length >= times) return claimed;
    lost.push(claimed);
    return undefined;
  });
  return { lost };
}

/** The leases of the test's stores no one released: their execution ids and holders. */
const heldLeasesOf = (app: TestApp): readonly string[] =>
  [...databaseOf(app).executionLeases.values()]
    .filter((row) => !row.released)
    .map((row) => `${row.lease.rootExecutionId} ${row.lease.holderInstanceId}`);

beforeEach(() => {
  resetYield();
  resetLogged();
});

describe("#720: a lease a reclaim keeps never outlives its look", () => {
  test("a child whose claims are lost twice on every instance is still run, once, and its lease ends", async ({
    apps,
    clock,
  }) => {
    const [a, b] = await bothReady(apps);
    const onA = loseClaims(a, 2);
    const onB = loseClaims(b, 2);
    const call = execute(a, YieldOneWorkflowStart, item("lost"), { threadId: "thread-lost" });
    let done: unknown;
    void call.then((value) => (done = value));
    // the parent's watch looks every second: a minute of it is many reclaims and sweeps
    for (let second = 0; second < 60 && done === undefined; second += 1) {
      await clock.advance(seconds(1));
      await settle();
    }

    expect(onA.lost.length + onB.lost.length).toBeGreaterThanOrEqual(2);
    expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "lost" });
    expect(yieldSeen.runs.map((run) => run.name)).toEqual(["lost"]);
    expect(heldLeasesOf(a)).toEqual([]);
  });
});
