/**
 * #596 — a child's failure, once announced, is its end. The parent's holder announces its child's
 * failure, then freezes before its step is checkpointed; another instance takes the tree over and
 * re-enters the step. Before the fix it ran the failed step again — a step that now succeeds made
 * the child heard failing *and* finishing, and the root end instead of failing — and a child with
 * an undo was heard failing twice. The announcement is a claim in the tree's store: one pass of all
 * that see the failure announces it, and a re-entry that finds the claim repeats the failure without
 * running the step.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { settle } from "./fixtures/fence-takeover.js";
import { item } from "./fixtures/finished-work.js";
import { frozenAfterChildEnd, heard, once, readyAll } from "./fixtures/child-end-freeze.js";
import {
  endOnceSeen,
  EndOnceLocalWorkflowStart,
  resetEndOnce,
} from "./fixtures/child-end-once.workflow.js";
import {
  ChildFailureOnceApplication,
  SidePathLocalWorkflowStart,
  UndoLocalWorkflowStart,
} from "./fixtures/child-failure-once.workflow.js";
import { resetUndo, undoSeen } from "./fixtures/finished-undo.workflow.js";
import { resetYield, yieldSeen } from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(ChildFailureOnceApplication, { instances: 2 });
const test3 = testWith(ChildFailureOnceApplication, { instances: 3 });

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetUndo();
  resetLogged();
});

/** The gated step's runs of the item. */
const runsOf = (name: string): number => yieldSeen.runs.filter((run) => run.name === name).length;

describe("#596 AC1: a child whose failure was announced does not finish after a takeover", () => {
  test("a step that fails once: the child's failure heard once, no end, the root fails once — the step not run again", async ({
    apps,
    clock,
    leases,
  }) => {
    const [a] = apps;
    if (a === undefined) throw new Error("two instances");
    await readyAll(apps);
    const call = execute(a, EndOnceLocalWorkflowStart, item("gate-flaky"), {
      threadId: "thread-a",
    });
    const error = await frozenAfterChildEnd(a, { clock, leases }, call);

    const { childEnds, childErrors, rootEnds, rootErrors } = heard();
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(childErrors).toHaveLength(1);
    expect(childEnds).toEqual([]);
    expect(rootErrors).toHaveLength(1);
    expect(rootEnds).toEqual([]);
    expect(runsOf("gate-flaky")).toBe(1);
  });

  test3(
    "two holders frozen in turn, the third ends the tree: the failure heard once, no end",
    async ({ apps, clock, leases }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("three instances");
      const byId = await readyAll(apps);
      const call = execute(a, EndOnceLocalWorkflowStart, item("gate-flaky"), {
        threadId: "thread-a",
      });
      endOnceSeen.onRecovered = once((instanceId) => {
        const taker = byId.get(instanceId);
        if (taker !== undefined) leases.stall(taker);
      });
      const error = await frozenAfterChildEnd(a, { clock, leases }, call);
      for (const each of apps) leases.resume(each);
      await settle();

      const { childEnds, childErrors, rootEnds, rootErrors } = heard();
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(childErrors).toHaveLength(1);
      expect(childEnds).toEqual([]);
      expect(rootErrors).toHaveLength(1);
      expect(rootEnds).toEqual([]);
      expect(runsOf("gate-flaky")).toBe(1);
    },
  );
});

describe("#596 AC2: the side path that takes the failure takes it again", () => {
  test("a ChildExecutionFailedError side path: the child's failure heard once, the root ends at its failed finish", async ({
    apps,
    clock,
    leases,
  }) => {
    const [a] = apps;
    if (a === undefined) throw new Error("two instances");
    await readyAll(apps);
    const call = execute(a, SidePathLocalWorkflowStart, item("gate-flaky"), {
      threadId: "thread-s",
    });
    const error = await frozenAfterChildEnd(a, { clock, leases }, call);

    const { childEnds, childErrors, rootEnds, rootErrors } = heard();
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(childErrors).toHaveLength(1);
    expect(childEnds).toEqual([]);
    expect(rootEnds).toMatchObject([{ workflow: "side-path-local-workflow" }]);
    expect(rootErrors).toEqual([]);
    expect(runsOf("gate-flaky")).toBe(1);
  });
});

describe("#596: a child with an undo", () => {
  test("its failure, after its undo, heard once — the instance that finishes the tree only repeats it; the undo ran once", async ({
    apps,
    clock,
    leases,
  }) => {
    const [a] = apps;
    if (a === undefined) throw new Error("two instances");
    await readyAll(apps);
    const call = execute(a, UndoLocalWorkflowStart, item("gate", "fail"), { threadId: "thread-u" });
    const error = await frozenAfterChildEnd(a, { clock, leases }, call);

    const { childEnds, childErrors, rootErrors } = heard();
    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(childErrors).toHaveLength(1);
    expect(childEnds).toEqual([]);
    expect(rootErrors).toHaveLength(1);
    expect(undoSeen.booked).toHaveLength(1);
    expect(undoSeen.cancelled).toHaveLength(1);
  });
});
