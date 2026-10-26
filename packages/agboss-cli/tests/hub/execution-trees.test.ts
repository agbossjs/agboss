/**
 * #401 PR 4 (AC6) — a tree started in application A that calls B over A2A, B calling C over MCP, is
 * one tree from three export files, stitched by each receiver's `origin` (the calling execution and
 * its call's idempotency key), never by tenant; a call whose receiver did not export is a stub; an
 * in-process child's calls hang under the child; a receiver whose caller exported nothing is a root
 * of its own, called by that caller.
 */
import { describe, expect, it } from "vitest";
import {
  ChildExecutionStatus,
  ComponentKind,
  type ChildExecutionRecord,
  type ExecutionHistoryRecord,
  type ToolCallRecord,
} from "@agboss/core";
import { bareRecordOf } from "../../../agboss/src/flow/runtime/records.js";
import { buildCostReport } from "../../../agboss/src/finops/usage.js";
import {
  historyRecordOf,
  toolCallOf,
} from "../../../agboss/tests/eval/fixtures/history-records.js";
import { executionTreeOf, executionTreesOf } from "../../src/hub/execution-trees.js";
import { renderHubPage } from "../../src/hub/html/hub-page.js";
import type { HubRecord } from "../../src/hub/hub-inputs.js";
import { meshOf } from "../../src/hub/mesh.js";

const remoteCall = (
  tool: string,
  key: string,
  application: string,
  executionId: string,
): ToolCallRecord => {
  const call = toolCallOf(tool, {});
  return {
    ...call,
    step: { ...call.step, idempotencyKey: key },
    remote: { application, executionId },
  };
};

const workflow = (name: string) => ({
  name,
  version: "1.0.0",
  startedVersion: "1.0.0",
  configHash: name,
});

const recordOf = (
  application: string,
  executionId: string,
  fields: Partial<ExecutionHistoryRecord> = {},
): HubRecord => ({
  file: `${application}.jsonl`,
  record: historyRecordOf(executionId, {
    application: { name: application, version: "1.0.0", instanceId: "i" },
    workflow: workflow(`${application.replace("-application", "")}-workflow`),
    tenantId: `${application}-tenant`, // each organisation its own tenant: never what stitches
    ...fields,
  }),
});

const originOf = (application: string, executionId: string, key: string) => ({
  application,
  hops: 1,
  rootExecutionId: executionId,
  executionId,
  workflow: { name: `${application.replace("-application", "")}-workflow`, version: "1.0.0" },
  step: { component: "caller-agent", idempotencyKey: key },
});

const childOf = (
  executionId: string,
  toolCalls: readonly ToolCallRecord[],
): ChildExecutionRecord => ({
  executionId,
  parentExecutionId: "a1",
  rootExecutionId: "a1",
  workflow: workflow("vendor-check-workflow"),
  depth: 2,
  launchedBy: { nodeId: "vendor-check-workflow", visitNumber: 1 },
  start: bareRecordOf("vendor-check-workflow-start", ComponentKind.WorkflowStart),
  input: {},
  status: ChildExecutionStatus.Finished,
  path: [],
  spend: buildCostReport([]),
  toolCalls,
  steps: [],
  pauses: [],
  children: [],
});

/** A calls B (A2A), B calls C (MCP); A's child calls D, which exported nothing; others alone. */
const RECORDS: readonly HubRecord[] = [
  recordOf("c-application", "c1", {
    origin: originOf("b-application", "b1", "b1:b-agent:1:call-c"),
  }),
  recordOf("a-application", "a1", {
    startedAt: "2026-01-05T08:00:00.000Z",
    toolCalls: [remoteCall("ask-b-tool", "a1:a-agent:1:call-b", "b-application", "b1")],
    children: [
      childOf("a1-child", [remoteCall("ask-d-tool", "a1-child:d:1:x", "d-application", "d1")]),
    ],
  }),
  recordOf("b-application", "b1", {
    origin: originOf("a-application", "a1", "a1:a-agent:1:call-b"),
    toolCalls: [remoteCall("search-c-tool", "b1:b-agent:1:call-c", "c-application", "c1")],
  }),
  recordOf("a-application", "a2"),
  recordOf("b-application", "b9", { origin: originOf("q-application", "q1", "q1:q:1:x") }),
];

describe("#401 PR 4: cross-service execution trees", () => {
  it("one tree across three exports, a stub for the receiver that exported nothing", () => {
    const trees = executionTreesOf(RECORDS);

    expect(
      trees.map(({ root, applications, executions, stubs }) => ({
        root: root.executionId,
        applications,
        executions,
        stubs,
      })),
    ).toEqual([
      {
        root: "a1",
        applications: ["a-application", "b-application", "c-application", "d-application"],
        executions: 4,
        stubs: 1,
      },
      { root: "b9", applications: ["b-application"], executions: 1, stubs: 0 },
    ]);
    const tree = executionTreeOf(trees, "a1");
    const [toB] = tree?.root.calls ?? [];
    expect(toB?.target).toMatchObject({
      kind: "execution",
      application: "b-application",
      executionId: "b1",
    });
    const [toC] = toB?.target.kind === "execution" ? toB.target.calls : [];
    expect(toC).toMatchObject({
      tool: "search-c-tool",
      target: { application: "c-application", executionId: "c1" },
    });
    expect(tree?.root.children[0]?.calls[0]?.target).toEqual({
      kind: "stub",
      application: "d-application",
      executionId: "d1",
    });
    expect(trees[1]?.calledBy).toEqual({ application: "q-application", executionId: "q1" });
    expect(executionTreeOf(trees, "a2")).toBeUndefined();
  });

  it("a receiver whose caller's record holds no remote call is a root of its own; the page shows the trees", () => {
    const caller = recordOf("a-application", "a7", { toolCalls: [toolCallOf("ask-b-tool", {})] });
    const receiver = recordOf("b-application", "b7", {
      origin: originOf("a-application", "a7", "a7:a:1:x"),
    });

    const trees = executionTreesOf([caller, receiver]);
    const page = renderHubPage(
      meshOf({ files: [], applications: [], evalRuns: [], records: RECORDS }),
    );

    expect(trees.map(({ root, calledBy }) => ({ root: root.executionId, calledBy }))).toEqual([
      { root: "b7", calledBy: { application: "a-application", executionId: "a7" } },
    ]);
    expect(page).toContain('id="tree-a1"');
    expect(page).toContain("a-application → b-application → c-application → d-application");
    expect(page).toContain("d-application · d1 (not exported)");
    expect(page).toContain("called by q-application · q1, whose call is not in the exports");
    expect(
      renderHubPage(meshOf({ files: [], applications: [], evalRuns: [], records: [] })),
    ).toContain("No execution in the records called another application.");
  });
});
