/**
 * #1356 (shard `a2a-files`): the moment before which an owner must have ended for its files to be up, per workflow
 * (#1316): `now` less the policy's ttl — the built-in 24 hours without a policy —, none for a policy that keeps for
 * ever, and none for a class that is no workflow.
 */
import { describe, expect, it } from "vitest";
import { fileCutoffsOf } from "../../../../src/application/file-expiry.js";
import { ComponentOptions } from "../../../../src/components/component-options.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { FilePolicy } from "../../../../src/files/file-policy.js";
import { Action } from "../../../../src/flow/decorators/action.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../src/flow/decorators/workflow-start.js";
import { hours, Ttl } from "../../../../src/units/index.js";
import { onStart } from "../../../helpers/flow.js";

@WorkflowStart({ name: "cutoff-workflow-start", description: "s", input: WorkflowStartTextDto })
class CutoffStart {}
@WorkflowFinish({ name: "cutoff-workflow-finish", description: "f", output: WorkflowFinishTextDto })
class CutoffFinish {}

@FilePolicy({ ttl: hours(2), name: "cutoff-short-file-policy" })
class ShortPolicy {}
@FilePolicy({ ttl: Ttl.Forever, name: "cutoff-forever-file-policy" })
class ForeverPolicy {}

@Workflow({
  name: "cutoff-short-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(CutoffStart).toFinish(CutoffFinish)],
  filePolicy: ShortPolicy,
})
class ShortWorkflow {}
@Workflow({
  name: "cutoff-forever-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(CutoffStart).toFinish(CutoffFinish)],
  filePolicy: ForeverPolicy,
})
class ForeverWorkflow {}
@Workflow({
  name: "cutoff-plain-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(CutoffStart).toFinish(CutoffFinish)],
})
class PlainWorkflow {}

@Action({
  name: "cutoff-action",
  description: "An action",
  input: { text: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
class CutoffAction {
  execute(): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: "x" });
  }
}
class Undecorated {
  readonly bare = true;
}

const NOW = new Date("2026-01-05T09:00:00.000Z");

describe("#1356: the cutoff of each workflow's files", () => {
  it("is now less the policy's ttl, the built-in 24 hours without one, and none for a policy that keeps for ever", () => {
    const cutoffs = fileCutoffsOf(
      [ShortWorkflow, ForeverWorkflow, PlainWorkflow],
      NOW,
      ComponentOptions.none,
    );

    expect(Object.fromEntries(cutoffs)).toEqual({
      "cutoff-short-workflow": new Date("2026-01-05T07:00:00.000Z"),
      "cutoff-plain-workflow": new Date("2026-01-04T09:00:00.000Z"),
    });
  });

  it("is none for a class that is no workflow: an action, a class with no declaration", () => {
    const cutoffs = fileCutoffsOf(
      [CutoffAction, Undecorated, ShortWorkflow],
      NOW,
      ComponentOptions.none,
    );

    expect([...cutoffs.keys()]).toEqual(["cutoff-short-workflow"]);
  });
});
