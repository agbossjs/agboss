/**
 * #633 (unwind shard) — where each entry of an ending tree undoes (`tree-undo-sites.ts`) on its
 * own: an execution's workflow found down its checkpoint namespace by its child nodes' names (a
 * recursion level and an unknown child stay on the workflow above), the root on the version it
 * started on and a descendant on its workflow's own, and the application's clock and bound —
 * the built-in ones without.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../../src/app/app-deps.js";
import {
  depsOfNamespace,
  undoSiteOf,
  type TreeUndoSites,
} from "../../../src/app/compensation/tree-undo-sites.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { COMPENSATION_TIMEOUT, CompensationReason } from "../../../src/flow/compensation.js";
import { ThisWorkflow } from "../../../src/flow/this-workflow.js";
import type { GraphDeps } from "../../../src/graph/deps.js";
import { systemClock } from "../../../src/infrastructure/clock.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { entryOf } from "../../flow/runtime/fixtures/compensation-entries.js";

vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({
  joinKeysOf: () => ({ components: new Map(), configHash: "hash" }),
  workflowIdentityOf: (deps: { config: { name: string; version: string } }) => ({
    type: Object,
    name: deps.config.name,
    version: deps.config.version,
    configHash: "hash",
  }),
}));

type Deps = GraphDeps<string> & { readonly label: string };

function depsNamed(
  label: string,
  version: string,
  nodes: Record<string, unknown>,
  children: Record<string, Deps> = {},
): Deps {
  const deps = {
    label,
    config: { name: label, version },
    graph: { nodes: new Map(Object.entries(nodes)) },
    childDepsOf: (component: unknown) =>
      Object.values(children).find(
        (child) => child.label === (component as { label?: string }).label,
      ),
  };
  return deps as never;
}

const night = depsNamed("night-workflow", "3.0.0", {});
const booking = depsNamed("booking-workflow", "2.0.0", {
  "night-workflow": {
    kind: NodeKind.Workflow,
    component: { label: "night-workflow" },
  },
});
const root = depsNamed(
  "desk-workflow",
  "1.0.0",
  {
    "booking-workflow": {
      kind: NodeKind.Workflow,
      component: { label: "booking-workflow" },
    },
    "this-workflow": { kind: NodeKind.Workflow, component: ThisWorkflow },
    "reserve-room-action": { kind: NodeKind.Action, component: Object },
    "lost-workflow": { kind: NodeKind.Workflow, component: { label: "lost" } },
  },
  { booking, night },
);
(booking as { childDepsOf: unknown }).childDepsOf = () => night;

describe("#633: depsOfNamespace", () => {
  it.each([
    ["", "desk-workflow"],
    ["booking-workflow:1", "booking-workflow"],
    ["booking-workflow:1|night-workflow:2", "night-workflow"],
    ["this-workflow:1", "desk-workflow"],
    ["reserve-room-action:1", "desk-workflow"],
    ["unknown-node:1|booking-workflow:1", "desk-workflow"],
    ["lost-workflow:1", "desk-workflow"],
    [":1", "desk-workflow"],
  ])("%j: %s", (namespace, label) => {
    expect((depsOfNamespace(root, namespace) as Deps).label).toBe(label);
  });
});

describe("#633: depsOfNamespace beyond its children", () => {
  it("a recursion level stays on its workflow even where the deps would name one for the marker", () => {
    const anything = { ...root, childDepsOf: () => night } as Deps;

    expect((depsOfNamespace(anything, "this-workflow:1") as Deps).label).toBe("desk-workflow");
  });

  it("deps that launch no children: a child node's namespace stays on them", () => {
    const bare = { ...root, childDepsOf: undefined } as Deps;

    expect((depsOfNamespace(bare, "booking-workflow:1") as Deps).label).toBe("desk-workflow");
  });
});

describe("#633: undoSiteOf", () => {
  function sitesOf(app: Partial<AppDeps> = {}): TreeUndoSites {
    return {
      deps: { ...root, observer: {}, stepEntries: undefined, ...app } as never,
      state: { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "0.9.0" },
      checkpoint: { contexts: { tenant: { tenantId: "acme" }, execution: { v: 1 } } } as never,
      ownerId: "alice",
      signal: new AbortController().signal,
      lease: { scopeKey: "acme:root-1" } as never,
      reason: CompensationReason.ExecutionCancelled,
      namespaces: new Map([["child-1", "booking-workflow:1"]]),
    };
  }

  it("the root on the version it started on, its owner, its values and the lease", () => {
    const sites = sitesOf();
    const site = undoSiteOf(sites, entryOf("k"));

    expect(site.execution).toMatchObject({
      executionId: "root-1",
      threadId: "thread-1",
      ownerId: "alice",
      workflow: { name: "desk-workflow", version: "1.0.0", startedVersion: "0.9.0" },
      values: { v: 1 },
      lease: sites.lease,
    });
    expect(site.reason).toBe(CompensationReason.ExecutionCancelled);
  });

  it("a descendant on its own workflow, its version; one of no namespace on the root's", () => {
    const sites = sitesOf();

    const child = undoSiteOf(sites, entryOf("k", { executionId: "child-1" }));
    const stray = undoSiteOf(sites, entryOf("k", { executionId: "child-9" }));

    expect(child.execution.workflow).toMatchObject({
      name: "booking-workflow",
      startedVersion: "2.0.0",
    });
    expect(stray.execution.workflow).toMatchObject({
      name: "desk-workflow",
      startedVersion: "1.0.0",
    });
  });

  it("the application's clock and bound; the built-in ones without", () => {
    const clock = new VirtualClock();
    const own = undoSiteOf(
      sitesOf({ clock, compensation: { timeout: seconds(9) } } as never),
      entryOf("k"),
    );
    const builtIn = undoSiteOf(
      sitesOf({ clock: undefined, compensation: undefined }),
      entryOf("k"),
    );

    expect([own.clock, own.timeout]).toEqual([clock, seconds(9)]);
    expect([builtIn.clock, builtIn.timeout]).toEqual([systemClock, COMPENSATION_TIMEOUT]);
  });
});
