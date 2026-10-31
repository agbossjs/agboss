/**
 * #597 — a root's end is announced once, and only by the pass that holds the tree's lease. The
 * root's holder freezes right after its end became durable (its finish checkpoint, its failed step's
 * error), before announcing it; another instance recovers the tree and announces its end. Before
 * the fix the old holder, thawed, announced it again and its call resolved with the output: nothing
 * between the end and `onExecutionEnd` looked at the lease. Now the thawed holder stops at its own
 * fence (#533): its call rejects with `ExecutionLeaseLostError` and it announces nothing.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import {
  childrenIn,
  endOnceSeen,
  EndOnceLocalWorkflowStart,
  resetEndOnce,
  rootsIn,
} from "./fixtures/child-end-once.workflow.js";
import { openGate, resetYield, yieldSeen } from "./fixtures/remote-child-yield.workflow.js";
import {
  atRootEnd,
  resetRootWindow,
  RootEndPoint,
  RootEndWindowApplication,
} from "./fixtures/root-end-window.workflow.js";

const test = testWith(RootEndWindowApplication, { instances: 2 });

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetRootWindow();
  resetLogged();
});

const CASES = [
  { at: RootEndPoint.Finish, outcome: "ok", heardOf: () => rootsIn(endOnceSeen.ends) },
  { at: RootEndPoint.Error, outcome: "fail", heardOf: () => rootsIn(endOnceSeen.errors) },
] as const;

describe("#597 AC1: the root's holder freezes right after its end became durable, another instance recovers it", () => {
  for (const { at, outcome, heardOf } of CASES)
    for (const thaws of ["before", "after"] as const)
      test(`its ${at}: heard once, by the instance that recovered it — the old holder, thawed ${thaws} that one ended, rejects with ExecutionLeaseLostError`, async ({
        apps,
        clock,
        leases,
      }) => {
        const [a, b] = apps;
        if (a === undefined || b === undefined) throw new Error("two instances");
        for (const app of [...apps].reverse()) await app.ready();
        let thaw = (): void => undefined;
        const thawed = new Promise<void>((resolve) => {
          thaw = resolve;
        });
        atRootEnd(at, async () => {
          leases.stall(a);
          await thawed;
        });
        const call = rejectionOf(
          execute(a, EndOnceLocalWorkflowStart, item("gate", outcome), { threadId: "thread-r" }),
        );
        await until(() => yieldSeen.runs.length === 1, "the child at its gate");
        openGate();
        // a's lease runs out while it is frozen: the other instance's sweep recovers the tree
        for (let step = 0; step < 4; step += 1) await clock.advance(seconds(10));
        if (thaws === "before") thaw();
        for (let step = 0; step < 4; step += 1) await clock.advance(seconds(10));
        await until(() => heardOf().length > 0, "the root's end heard");
        thaw();
        await settle();
        leases.resume(a);
        const error = await call;
        await settle();

        expect(error).toBeInstanceOf(ExecutionLeaseLostError);
        expect(heardOf()).toHaveLength(1);
        expect(heardOf()[0]).not.toMatchObject({ instanceId: "instance-2" });
        expect(rootsIn(endOnceSeen.ends).length + rootsIn(endOnceSeen.errors).length).toBe(1);
        expect(childrenIn(outcome === "ok" ? endOnceSeen.ends : endOnceSeen.errors)).toHaveLength(
          1,
        );
      });
});
