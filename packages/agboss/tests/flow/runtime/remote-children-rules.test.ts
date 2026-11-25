import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../../src/application/start-log.js";
import type { Class } from "../../../src/components/injection.js";
import {
  placementOfWorkflow,
  treeLaunchesQueued,
} from "../../../src/flow/analyse/child-placements.js";
import { ChildPlacement } from "../../../src/flow/child-placement.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { ItemDto } from "./fixtures/fan-out.workflow.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { flowLines } from "../../../src/flow/print.js";
import { onStart, toWorkflow } from "../../helpers/flow.js";
import {
  ItemReviewedWorkflowFinish,
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
import { Ttl } from "../../../src/index.js";

/**
 * #333 PR 2, PR 4 — the placement of a child at assembly: printed as written, one per child
 * (`[flow.conflicting-placement]`), a child that can pause allowed on any instance (PR 4), and
 * `[application.in-memory-child-queue]` on the built-in queue.
 */

type Flow = WorkflowOptions["flow"];

let count = 0;
function workflowWith(flow: Flow): abstract new () => unknown {
  count += 1;
  @Workflow({
    name: `placement-case-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow,
  })
  class PlacementCaseWorkflow {}
  return PlacementCaseWorkflow;
}

function childWith(placement: ChildPlacement | undefined): Class {
  count += 1;
  @WorkflowStart({
    name: `placed-${String(count)}-workflow-start`,
    description: "d",
    input: ItemDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `placed-${String(count)}-workflow-finish`,
    description: "d",
    output: ItemDto,
  })
  class Finish {}
  @Workflow({
    name: `placed-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    ...(placement === undefined ? {} : { placement }),
    flow: [onStart(Start).toFinish(Finish)],
  })
  class Placed {}
  return Placed;
}

describe("#1286: placement is the child's, never the flow's", () => {
  it("the flow prints no placement (describe, the config fingerprint)", () => {
    const lines = flowLines(
      [
        onStart(RemoteOneWorkflowStart)
          .toWorkflow(RemoteItemWorkflow)
          .toFinish(RemoteOneCheckedWorkflowFinish),
      ],
      (cls) => cls.name,
    );

    expect(lines).toContain("  .toWorkflow(RemoteItemWorkflow)");
  });

  it("a launch prints its limits only", () => {
    const lines = flowLines(
      [
        onStart(RemoteOneWorkflowStart)
          .forEachItem(toWorkflow(RemoteItemWorkflow), { takeFirst: 3 })
          .join()
          .toFinish(RemoteOneCheckedWorkflowFinish),
      ],
      (cls) => cls.name,
    );

    expect(lines).toContain("  .forEachItem(toWorkflow(RemoteItemWorkflow), { takeFirst: 3 })");
  });

  it("the child's own placement wins over the application's default, which wins over the process", () => {
    const own = childWith(ChildPlacement.OtherWorker);
    const bare = childWith(undefined);

    expect(placementOfWorkflow(own, ChildPlacement.AnyWorker, undefined)).toBe(
      ChildPlacement.OtherWorker,
    );
    expect(placementOfWorkflow(bare, ChildPlacement.AnyWorker, undefined)).toBe(
      ChildPlacement.AnyWorker,
    );
    expect(placementOfWorkflow(bare, undefined, undefined)).toBe(ChildPlacement.CurrentProcess);
  });

  it("a child's placement is never its parent's", () => {
    const child = childWith(undefined);
    const parent = workflowWith([onStart(RemoteOneWorkflowStart).toWorkflow(child)]);

    expect(placementOfWorkflow(child, undefined, undefined)).toBe(ChildPlacement.CurrentProcess);
    expect(placementOfWorkflow(parent, undefined, undefined)).toBe(ChildPlacement.CurrentProcess);
  });

  it("a tree launches through the queue when a child below it does, by its own or the default", () => {
    const queued = childWith(ChildPlacement.AnyWorker);
    const bare = childWith(undefined);
    const withQueued = workflowWith([onStart(ReviewOneWorkflowStart).toWorkflow(queued)]);
    const withBare = workflowWith([onStart(ReviewOneWorkflowStart).toWorkflow(bare)]);

    expect(treeLaunchesQueued(withQueued, undefined, undefined)).toBe(true);
    expect(treeLaunchesQueued(withBare, undefined, undefined)).toBe(false);
    expect(treeLaunchesQueued(withBare, ChildPlacement.OtherWorker, undefined)).toBe(true);
  });

  it("a child that can pause may run on any worker (#333 PR 4)", () => {
    const parent = workflowWith([
      onStart(ReviewOneWorkflowStart)
        .toWorkflow(ItemReviewWorkflow)
        .toFinish(ItemReviewedWorkflowFinish),
    ]);

    expect(checkWorkflow(parent).errors).toEqual([]);
  });
});

describe("#333 PR 2: [application.in-memory-child-queue]", () => {
  it("children on any instance on the built-in queue warn", async () => {
    const assembled = await applicationOf(RemoteChildrenApplication);

    expect(assemblyWarningsOf(assembled)).toContainEqual({
      code: "application.in-memory-child-queue",
      message:
        "in-memory child queue: children of a workflow with a placement other than CurrentProcess run only on the instance that launched them — name a durable @DatabaseStorage in @Application({ storage }) (or list your own ChildExecutionQueueRepository) so another instance claims them",
    });
  });

  it("a listed queue does not", async () => {
    const assembled = await applicationOf(RemoteSqliteApplication);

    expect(assemblyWarningsOf(assembled).map((warning) => warning.code)).not.toContain(
      "application.in-memory-child-queue",
    );
  });
});
