/**
 * #336 AC2 — a root's `configSnapshot` covers its child workflows: `children` holds every child
 * reachable from its flow, recursively, each once by name with its own snapshot; `ThisWorkflow` is
 * never one (a recursive workflow is hashed once); a workflow without children keeps its hash; the
 * hash a run carries is the hash `agboss describe --json` gives.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describeServices } from "../../src/describe/describe-workflow.js";
import { workflowSnapshotOf } from "../../src/describe/snapshot.js";
import { childSourcesIn, configSnapshot } from "../../src/run/versions.js";
import { versionOf } from "../../src/terns/index.js";
import { testWith } from "../../src/testing/index.js";
import type { AssembledWorkflow } from "../../src/workflow.js";
import { execute } from "../helpers/flow.js";
import {
  ChildrenApplication,
  childLog,
  DeepCheckItemsWorkflowStart,
  resetChildLog,
} from "../flow/runtime/fixtures/children.workflow.js";
import { RecursionApplication } from "../flow/runtime/fixtures/recursion.workflow.js";

const children = await applicationOf(ChildrenApplication);
const recursion = await applicationOf(RecursionApplication);
const sources = childSourcesIn(children.workflows);

const named = (workflows: readonly AssembledWorkflow[], name: string): AssembledWorkflow => {
  const found = workflows.find((workflow) => workflow.config.name === name);
  if (found === undefined) throw new TypeError(`the fixture has no ${name}`);
  return found;
};

/** The snapshot as a plain object, to read its keys. */
const snapshotOf = (
  bundle: AssembledWorkflow,
  workflows: readonly AssembledWorkflow[],
): Readonly<Record<string, unknown>> =>
  configSnapshot(bundle, childSourcesIn(workflows)) as Readonly<Record<string, unknown>>;

describe("#336 AC2: a root's configSnapshot covers its children", () => {
  test("every child reachable from the flow, recursively, each once by name", () => {
    const deep = named(children.workflows, "deep-check-items-workflow");

    const snapshot = snapshotOf(deep, children.workflows);

    const nested = snapshot.children as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    expect(Object.keys(nested)).toEqual(["item-check-workflow", "item-deep-check-workflow"]);
    // each child's own snapshot: the tree is listed once, at the root
    expect(nested["item-deep-check-workflow"]).not.toHaveProperty("children");
    expect(nested["item-check-workflow"]).toEqual(
      configSnapshot(named(children.workflows, "item-check-workflow")),
    );
  });

  test("a grandchild's change is part of its root's hash, and of its parent's", () => {
    const deep = named(children.workflows, "deep-check-items-workflow");
    const middle = named(children.workflows, "item-deep-check-workflow");
    const leaf = named(children.workflows, "item-check-workflow");
    const changed: AssembledWorkflow = {
      ...leaf,
      config: { ...leaf.config, version: "2.0.0" },
    };
    const deployed = children.workflows.map((workflow) => (workflow === leaf ? changed : workflow));

    expect(versionOf(snapshotOf(deep, deployed))).not.toBe(
      versionOf(snapshotOf(deep, children.workflows)),
    );
    expect(versionOf(snapshotOf(middle, deployed))).not.toBe(
      versionOf(snapshotOf(middle, children.workflows)),
    );
  });

  test("a workflow without children keeps its hash: no children key", () => {
    const leaf = named(children.workflows, "item-check-workflow");

    expect(snapshotOf(leaf, children.workflows)).not.toHaveProperty("children");
    expect(versionOf(snapshotOf(leaf, children.workflows))).toBe(versionOf(configSnapshot(leaf)));
  });

  test("a recursive workflow hashes itself once: ThisWorkflow is not a child", () => {
    const topic = named(recursion.workflows, "topic-research-workflow");

    const snapshot = snapshotOf(topic, recursion.workflows);

    expect(snapshot).not.toHaveProperty("children");
    expect(versionOf(snapshot)).toBe(versionOf(configSnapshot(topic)));
  });
});

const run = testWith(ChildrenApplication);
const who = {
  tenant: { tenantId: "acme", plan: "pro" },
  execution: { userId: "u1" },
  ownerId: "dana",
};

beforeEach(resetChildLog);

describe("#336 AC2: a run carries the hash describe --json gives", () => {
  run("a parent's execution events and describe's snapshot agree", async ({ app }) => {
    const deep = named(children.workflows, "deep-check-items-workflow");
    const described = workflowSnapshotOf(deep, describeServices, sources);

    await execute(app, DeepCheckItemsWorkflowStart, [{ name: "a", delay: 0, outcome: "ok" }], who);

    const root = childLog.starts.find((event) => event.parentExecutionId === undefined);
    expect(root?.workflow.configHash).toBe(described.configHash);
    expect(described.configHash).not.toBe(workflowSnapshotOf(deep, describeServices).configHash);
  });
});
