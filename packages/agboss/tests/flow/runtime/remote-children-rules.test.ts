import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../../src/application/start-log.js";
import { ChildPlacement } from "../../../src/flow/child-placement.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { flowLines } from "../../../src/flow/print.js";
import { FlowSyntaxError } from "../../../src/flow/path-builder.js";
import { listOf } from "../../../src/flow/dto-wrappers.js";
import { route, start } from "../../helpers/flow.js";
import { ItemDto, ItemResultDto } from "./fixtures/fan-out.workflow.js";
import {
  ItemReviewedWorkflowFinish,
  ItemReviewerAgent,
  ItemReviewWorkflow,
  ReviewOneWorkflowStart,
} from "./fixtures/children.workflow.js";
import {
  RemoteChildrenApplication,
  RemoteItemWorkflow,
  RemoteOneCheckedWorkflowFinish,
  RemoteOneWorkflowStart,
} from "./fixtures/remote-children.workflow.js";
import { RemoteSqliteApplication } from "../../infrastructure/sqlite/fixtures/remote-children.application.js";

/**
 * #333 PR 2 — the placement of a child at assembly: printed as written, one per child
 * (`[flow.conflicting-placement]`), never one that can pause (`[graph.remote-child-can-pause]`,
 * until PR 4), and `[application.in-memory-child-queue]` on the built-in queue.
 */

type Flow = WorkflowOptions["flow"];

let count = 0;
function workflowWith(flow: Flow): abstract new () => unknown {
  count += 1;
  @Workflow({ name: `placement-case-${String(count)}-workflow`, version: "1.0.0", flow })
  class PlacementCaseWorkflow {}
  return PlacementCaseWorkflow;
}

const unnamed = (found: { readonly code: string; readonly message: string }) => ({
  code: found.code,
  message: found.message.replace(/^placement-case-\d+-workflow: /, ""),
});

describe("#333 PR 2: placement at assembly", () => {
  it("is printed as written (describe, the config fingerprint)", () => {
    const lines = flowLines(
      [
        start(RemoteOneWorkflowStart)
          .returns(ItemDto)
          .toWorkflow(RemoteItemWorkflow, { placement: ChildPlacement.AnyInstance })
          .returns(ItemResultDto)
          .toFinish(RemoteOneCheckedWorkflowFinish),
      ],
      (cls) => cls.name,
    );

    expect(lines).toContain(
      "  .toWorkflow(RemoteItemWorkflow, { placement: ChildPlacement.AnyInstance })",
    );
  });

  it("a launch prints it with its limits", () => {
    const lines = flowLines(
      [
        start(RemoteOneWorkflowStart)
          .returns(listOf(ItemDto))
          .toParallelWorkflows(RemoteItemWorkflow, {
            maxItems: 3,
            placement: ChildPlacement.AnyInstance,
          })
          .join()
          .returns(listOf(ItemResultDto))
          .toFinish(RemoteOneCheckedWorkflowFinish),
      ],
      (cls) => cls.name,
    );

    expect(lines).toContain(
      "  .toParallelWorkflows(RemoteItemWorkflow, { maxItems: 3, placement: ChildPlacement.AnyInstance })",
    );
  });

  it("only a child workflow takes one; anything else is refused", () => {
    expect(() =>
      start(RemoteOneWorkflowStart)
        .returns(ItemDto)
        .toWorkflow(RemoteItemWorkflow, { placement: "elsewhere" }),
    ).toThrow(FlowSyntaxError);
    expect(() =>
      start(RemoteOneWorkflowStart)
        .returns(ItemDto)
        .toParallelAgents(ItemReviewerAgent, { placement: ChildPlacement.AnyInstance }),
    ).toThrow("only a child workflow has a placement");
  });

  it("a child that can pause, on any instance: named with its pause and the fix", () => {
    const parent = workflowWith([
      start(ReviewOneWorkflowStart)
        .returns(ItemDto)
        .toWorkflow(ItemReviewWorkflow, { placement: ChildPlacement.AnyInstance })
        .returns(ItemResultDto)
        .toFinish(ItemReviewedWorkflowFinish),
    ]);

    expect(checkWorkflow(parent).errors.map(unnamed)).toContainEqual({
      code: "graph.remote-child-can-pause",
      message:
        "item-review-workflow runs on any instance (placement: ChildPlacement.AnyInstance), but its tool confirm-review-tool pauses for terminal-user-channel — a child on another instance cannot pause until #333 PR 4: launch it with placement: ChildPlacement.ParentInstance",
    });
  });

  it("the same child on its parent's instance may pause", () => {
    const parent = workflowWith([
      start(ReviewOneWorkflowStart)
        .returns(ItemDto)
        .toWorkflow(ItemReviewWorkflow, { placement: ChildPlacement.ParentInstance })
        .returns(ItemResultDto)
        .toFinish(ItemReviewedWorkflowFinish),
    ]);

    expect(checkWorkflow(parent).errors).toEqual([]);
  });

  it("one child with two placements: [flow.conflicting-placement]", () => {
    const parent = workflowWith([
      start(RemoteOneWorkflowStart)
        .returns(ItemDto)
        .toAgent(ItemReviewerAgent)
        .chooseOne(
          route(RemoteItemWorkflow, { placement: ChildPlacement.AnyInstance }),
          route(RemoteItemWorkflow),
        ),
    ]);

    expect(checkWorkflow(parent).errors.map((found) => found.code)).toContain(
      "flow.conflicting-placement",
    );
  });
});

describe("#333 PR 2: [application.in-memory-child-queue]", () => {
  it("children on any instance on the built-in queue warn", async () => {
    const assembled = await applicationOf(RemoteChildrenApplication);

    expect(assemblyWarningsOf(assembled)).toContainEqual({
      code: "application.in-memory-child-queue",
      message:
        "in-memory child queue: children launched with placement: ChildPlacement.AnyInstance run only on the instance that launched them — list SqliteChildExecutionQueueRepository (or your own ChildExecutionQueueRepository) so any instance claims them",
    });
  });

  it("a listed queue does not", async () => {
    const assembled = await applicationOf(RemoteSqliteApplication);

    expect(assemblyWarningsOf(assembled).map((warning) => warning.code)).not.toContain(
      "application.in-memory-child-queue",
    );
  });
});
