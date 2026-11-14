/**
 * #928 AC1 — the twins of #720's lost answers: where #720 loses an answer (the store applied the
 * call, its caller hears an error at once), the twin holds it and never releases it (a silent
 * peer): the bound turns it into the same error at 15 s, and the same end follows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildExecutionQueueRepository, StoreCallTimeoutError } from "../../src/index.js";
import { STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import { testWith } from "../../src/testing/index.js";
import { HoldPhase, HoldPoints, processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { settle } from "./fixtures/fence-takeover.js";
import { bothReady, databaseOf, item } from "./fixtures/finished-work.js";
import { boundedOver, outcomeOf } from "./fixtures/bound-stubs.js";
import { LostAnswerApplication } from "./fixtures/lost-answer.application.js";
import {
  resetYield,
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

beforeEach(() => {
  resetYield();
  resetLogged();
});

afterEach(() => {
  processHoldPoints.releaseAll();
});

/** A store of the child queue whose claim answers through the hold point, as the held stores do. */
class HeldClaims {
  constructor(private readonly points: HoldPoints) {}

  async claim(key: string | undefined): Promise<string | undefined> {
    await this.points.reach(StoreHoldPoint.ChildClaim, HoldPhase.After, key);
    return key;
  }
}

describe("#720 twin (hold-points): a held answer, never released, is bounded", () => {
  it("holds the next keyed answers after the store, as many as armed, announces each; the bound rejects each at 15 s; the next goes through", async () => {
    const points = new HoldPoints();
    const heard: string[] = [];
    points.onHeld((operation) => heard.push(`${operation.phase}:${String(operation.key)}`));
    points.arm({ point: StoreHoldPoint.ChildClaim, phase: HoldPhase.After, times: 2 });
    const { store, clock } = boundedOver(ChildExecutionQueueRepository, new HeldClaims(points));
    // another phase: through
    await expect(
      points.reach(StoreHoldPoint.ChildClaim, HoldPhase.Before, "c-1"),
    ).resolves.toBeUndefined();

    const first = outcomeOf(store.claim("c-1"));
    const second = outcomeOf(store.claim("c-2"));
    await clock.advance(STORE_CALL_BOUND);

    for (const error of [await first, await second]) {
      expect(error).toBeInstanceOf(StoreCallTimeoutError);
      expect(error).toMatchObject({
        operation: "claim",
        timeout: STORE_CALL_BOUND,
        source: "framework",
      });
    }
    expect(heard).toEqual(["after:c-1", "after:c-2"]);
    // nothing was released: both answers are still held, and the third arrival is not
    expect(points.held.map((held) => held.key)).toEqual(["c-1", "c-2"]);
    await expect(store.claim("c-3")).resolves.toBe("c-3");
  });
});

const test = testWith(LostAnswerApplication, { instances: 2 });

describe("#720 twin (lost-claim-reclaim): claims never answered", () => {
  test("a child whose claim answers are held for ever, twice, is still run, once: the claims time out at 15 s, the reclaim runs it, the batch ends", async ({
    apps,
    clock,
  }) => {
    const [a] = await bothReady(apps);
    const call = execute(a, YieldOneWorkflowStart, item("lost"), { threadId: "thread-lost" });
    let done: unknown;
    void call.then((value) => (done = value));
    await until(() => databaseOf(a).childQueue.size === 1, "the child is queued");
    const [child] = [...databaseOf(a).childQueue.values()];
    // the store claims the child for an instance and the answer never arrives: twice
    processHoldPoints.arm({
      point: StoreHoldPoint.ChildClaim,
      phase: HoldPhase.After,
      key: child?.executionId ?? "no child",
      times: 2,
    });
    for (let second = 0; second < 240 && done === undefined; second += 1) {
      await clock.advance(seconds(1));
      await settle();
    }

    expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "lost" });
    expect(yieldSeen.runs.map((run) => run.name)).toEqual(["lost"]);
    // the two claims were never answered: each ended at the bound, as a store error
    const claims = logged.filter(
      (entry) =>
        entry.code === "store.call-timeout" &&
        entry.message.includes("claimFirstByStatusQueuedOrderByDepthDesc"),
    );
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(processHoldPoints.held).toHaveLength(2);
    const unreleased = [...databaseOf(a).executionLeases.values()].filter((row) => !row.released);
    expect(unreleased).toEqual([]);
  });
});
