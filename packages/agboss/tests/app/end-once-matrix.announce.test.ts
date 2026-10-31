/**
 * #596 / #597 acceptance — the matrix of a child's end announced, then its parent's holder frozen
 * before its step is checkpointed: a child on the parent's instance or on any, with or without an
 * undo, that finishes, fails, or fails its first run only (a dependency that recovers), the tree
 * taken over once or twice, the old holders thawed after the last one ended it. Every end — the
 * child's and the root's, a finish or a failure — is heard exactly once, the outcome is the one the
 * first holder saw, and nothing ran twice.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
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
import { UndoLocalWorkflowStart } from "./fixtures/child-failure-once.workflow.js";
import { resetUndo, undoSeen, UndoOneWorkflowStart } from "./fixtures/finished-undo.workflow.js";
import { resetMatrix, EndOnceMatrixApplication } from "./fixtures/end-once-matrix.workflow.js";
import {
  resetYield,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test2 = testWith(EndOnceMatrixApplication, { instances: 2 });
const test3 = testWith(EndOnceMatrixApplication, { instances: 3 });

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetUndo();
  resetMatrix();
  resetLogged();
});

const ROOTS = [
  { child: "ParentInstance", start: EndOnceLocalWorkflowStart, hasUndo: false },
  { child: "AnyInstance", start: YieldOneWorkflowStart, hasUndo: false },
  { child: "ParentInstance with an undo", start: UndoLocalWorkflowStart, hasUndo: true },
  { child: "AnyInstance with an undo", start: UndoOneWorkflowStart, hasUndo: true },
] as const;

const OUTCOMES = [
  { outcome: "finishes", input: item("gate"), finishes: true },
  { outcome: "fails", input: item("gate", "fail"), finishes: false },
  { outcome: "fails its first run only", input: item("gate-flaky"), finishes: false },
] as const;

const TAKEOVERS = [
  { takeovers: 1, test: test2 },
  { takeovers: 2, test: test3 },
] as const;

/** The tree run on `a`, frozen at the child's announcement; `takeovers - 1` takers frozen too. */
async function frozen(
  apps: readonly TestApp[],
  fixtures: Parameters<typeof frozenAfterChildEnd>[1],
  run: { readonly start: (typeof ROOTS)[number]["start"]; readonly input: ReturnType<typeof item> },
): Promise<unknown> {
  const [a] = apps;
  if (a === undefined) throw new Error("instances");
  const byId = await readyAll(apps);
  const call = execute(a, run.start, run.input, { threadId: "thread-m" });
  if (apps.length > 2)
    endOnceSeen.onRecovered = once((instanceId) => {
      const taker = byId.get(instanceId);
      if (taker !== undefined) fixtures.leases.stall(taker);
    });
  const error = await frozenAfterChildEnd(a, fixtures, call);
  for (const each of apps) fixtures.leases.resume(each);
  await settle();
  return error;
}

describe("#596/#597 acceptance: the parent's holder freezes right after announcing its child's end", () => {
  for (const { child, start, hasUndo } of ROOTS)
    for (const { outcome, input, finishes } of OUTCOMES)
      for (const { takeovers, test } of TAKEOVERS)
        test(`a ${child} child that ${outcome}, ${String(takeovers)} takeover(s): every end heard once, the first holder's outcome`, async ({
          apps,
          clock,
          leases,
        }) => {
          const error = await frozen(apps, { clock, leases }, { start, input });

          const { childEnds, childErrors, rootEnds, rootErrors } = heard();
          expect(error).toBeInstanceOf(ExecutionLeaseLostError);
          expect(childEnds).toHaveLength(finishes ? 1 : 0);
          expect(childErrors).toHaveLength(finishes ? 0 : 1);
          expect(rootEnds).toHaveLength(finishes ? 1 : 0);
          expect(rootErrors).toHaveLength(finishes ? 0 : 1);
          // the gated step ran once: never again after its end — a claimed failure not re-run
          expect(yieldSeen.runs.map((run) => run.name)).toEqual([input.name]);
          if (hasUndo) {
            expect(undoSeen.booked).toHaveLength(1);
            expect(undoSeen.cancelled).toHaveLength(finishes ? 0 : 1);
          }
        });
});
