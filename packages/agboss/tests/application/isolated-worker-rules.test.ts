/**
 * #1286b (D9): `@Application({ isolatedWorker: { entry } })` is required once a child workflow runs with
 * `ChildPlacement.IsolatedWorker` — by its own placement or the application's default — and the entry is a
 * file URL or an absolute path. The shard `assembly-rules` mutates `isolated-worker-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import type { ApplicationOptions } from "../../src/application/application.js";
import { isolatedWorkerViolations } from "../../src/application/isolated-worker-rules.js";
import type { Class } from "../../src/components/injection.js";
import { EmptyEnvironment, SqliteChildExecutionQueueRepository } from "../../src/index.js";
import { ChildPlacement } from "../../src/flow/child-placement.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { ItemDto } from "../flow/runtime/fixtures/fan-out.workflow.js";
import { onStart } from "../helpers/flow.js";

const NAME = "isolated-application";

let count = 0;
/** A parent workflow with one child, placed as given. */
function parentWith(placement: ChildPlacement | undefined): Class {
  count += 1;
  const id = String(count);
  @WorkflowStart({ name: `iso-${id}-workflow-start`, description: "d", input: ItemDto })
  class Start {}
  @WorkflowFinish({ name: `iso-${id}-workflow-finish`, description: "d", output: ItemDto })
  class Finish {}
  @Workflow({
    name: `iso-${id}-child-workflow`,
    version: "1.0.0",
    ...(placement === undefined ? {} : { placement }),
    flow: [onStart(Start).toFinish(Finish)],
  })
  class Child {}
  @WorkflowStart({ name: `iso-${id}-parent-workflow-start`, description: "d", input: ItemDto })
  class ParentStart {}
  @Workflow({
    name: `iso-${id}-parent-workflow`,
    version: "1.0.0",
    flow: [onStart(ParentStart).toWorkflow(Child).toFinish(Finish)],
  })
  class Parent {}
  return Parent;
}

const options = (rest: Partial<ApplicationOptions>): ApplicationOptions => ({
  name: NAME,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [],
  ...rest,
});

describe("#1286b: isolatedWorkerViolations", () => {
  it("finds nothing when no child runs isolated", () => {
    expect(isolatedWorkerViolations(options({ workflows: [parentWith(undefined)] }))).toEqual([]);
    expect(
      isolatedWorkerViolations(options({ workflows: [parentWith(ChildPlacement.OtherWorker)] })),
    ).toEqual([]);
  });

  it("requires the entry for a child placed IsolatedWorker, by its own placement", () => {
    const found = isolatedWorkerViolations(
      options({ workflows: [parentWith(ChildPlacement.IsolatedWorker)] }),
    );

    expect(found.map((one) => one.code)).toEqual(["application.isolated-worker-invalid"]);
    expect(found[0]?.nodes).toEqual([NAME]);
  });

  it("requires the entry for a child that the application's default places IsolatedWorker", () => {
    const found = isolatedWorkerViolations(
      options({
        workflows: [parentWith(undefined)],
        defaults: { workflows: { placement: ChildPlacement.IsolatedWorker } },
      }),
    );

    expect(found.map((one) => one.code)).toEqual(["application.isolated-worker-invalid"]);
  });

  it("is satisfied by a file URL or an absolute path", () => {
    for (const entry of ["file:///app/main.js", "/app/main.js", "C:\\app\\main.js"]) {
      expect(
        isolatedWorkerViolations(
          options({
            workflows: [parentWith(ChildPlacement.IsolatedWorker)],
            isolatedWorker: { entry },
            providers: [SqliteChildExecutionQueueRepository],
          }),
        ),
      ).toEqual([]);
    }
  });

  it("refuses the built-in in-memory child queue: no other process reaches it", () => {
    const found = isolatedWorkerViolations(
      options({
        workflows: [parentWith(ChildPlacement.IsolatedWorker)],
        isolatedWorker: { entry: "file:///app/main.js" },
      }),
    );

    expect(found.map((one) => one.code)).toEqual(["application.isolated-worker-invalid"]);
  });

  it("refuses an entry that is neither, with or without an isolated child", () => {
    for (const entry of ["", "./main.js", "main.js"]) {
      const found = isolatedWorkerViolations(options({ isolatedWorker: { entry } }));

      expect(found.map((one) => one.code)).toEqual(["application.isolated-worker-invalid"]);
    }
  });
});
