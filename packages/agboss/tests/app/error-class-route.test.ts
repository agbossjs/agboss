/**
 * #598 — a side path on the child's own error class is taken the same way on every holder. A child
 * declines a payment (`PaymentDeclinedError`); its parent routes `.onError(PaymentDeclinedError, …)`
 * to its declined finish. Before the fix, the failure crossing a takeover (the claim of #596, the
 * undo's mark of #340) or an instance (a remote child's queue row) came back as a plain error with
 * the name and message only: the instance that took the tree over — or, for a remote child, every
 * instance — failed the root instead. Now the failure's record (its class line by code, its causes)
 * is durable and the rebuilt failure routes as the original did.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import { liveFor, once, readyAll, type Fixtures } from "./fixtures/child-end-freeze.js";
import { resetUndo, undoSeen } from "./fixtures/finished-undo.workflow.js";
import {
  ErrorClassRouteApplication,
  PARENTS,
  resetRoutes,
  routeSeen,
} from "./fixtures/error-class-route.workflow.js";

const test = testWith(ErrorClassRouteApplication, { instances: 2 });

beforeEach(() => {
  resetRoutes();
  resetUndo();
  resetLogged();
});

const DECLINES = [
  { declines: "declines", input: item("gate", "fail") },
  { declines: "declines its first run only", input: item("gate-flaky") },
] as const;

/** The parent on `a`; at the child's announced failure `a` freezes, the other instance goes on. */
async function frozenAfterDecline(a: TestApp, { clock, leases }: Fixtures, call: Promise<unknown>) {
  await until(() => routeSeen.runs.length === 1, "the child at its gate");
  routeSeen.onChildError = once(() => {
    leases.stall(a);
  });
  routeSeen.gate.open();
  await until(() => routeSeen.errors.some((each) => each.isChild), "the child's failure heard");
  await liveFor(clock, 7);
  await until(() => routeSeen.finishes.length > 0, "the tree ended where it was taken over");
  leases.resume(a);
  const error = await rejectionOf(call);
  await settle();
  return error;
}

/** The tree's way: its root's finish, every root failure, the declining step's runs. */
const routed = () => ({
  finishes: routeSeen.finishes.map((each) => each.finish),
  rootErrors: routeSeen.errors.filter((each) => !each.isChild).map((each) => each.error),
  childErrors: routeSeen.errors.filter((each) => each.isChild).length,
  runs: routeSeen.runs.length,
});

describe("#598 AC1: the side path on the child's own error class, with and without a takeover", () => {
  for (const { child, start } of PARENTS)
    for (const { declines, input } of DECLINES) {
      test(`a ${child} child that ${declines}, no takeover: the declined finish`, async ({
        apps,
      }) => {
        const [a] = apps;
        if (a === undefined) throw new Error("two instances");
        await readyAll(apps);
        const call = execute(a, start, input, { threadId: "thread-r" });
        routeSeen.gate.open();
        await call;
        await settle();

        expect(routed()).toEqual({
          finishes: ["declined-workflow-finish"],
          rootErrors: [],
          childErrors: 1,
          runs: 1,
        });
      });

      test(`a ${child} child that ${declines}, its parent's holder frozen after announcing it: the same declined finish on the instance that took the tree over`, async ({
        apps,
        clock,
        leases,
      }) => {
        const [a] = apps;
        if (a === undefined) throw new Error("two instances");
        await readyAll(apps);
        const call = execute(a, start, input, { threadId: "thread-r" });
        const error = await frozenAfterDecline(a, { clock, leases }, call);

        expect(error).toBeInstanceOf(ExecutionLeaseLostError);
        expect(routed()).toEqual({
          finishes: ["declined-workflow-finish"],
          rootErrors: [],
          childErrors: 1,
          runs: 1,
        });
        expect(routeSeen.finishes[0]?.instanceId).not.toBe("instance-2");
        expect(undoSeen.cancelled.length).toBeLessThanOrEqual(1);
      });
    }
});
