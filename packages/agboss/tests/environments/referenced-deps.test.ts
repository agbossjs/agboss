/**
 * #1324b: the process variables an application needs include those of a workflow's action, tool or
 * router that reads `deps: [appEnv]`, not only those named in a component's options.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { referencedVariablesOf } from "../../src/application/referenced-variables.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Action,
  defineEnv,
  env,
  secret,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type InferEnv,
} from "../../src/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";

const depsEnv = defineEnv({
  upstream: env("DEPS_UPSTREAM_URL"),
  token: secret("DEPS_UPSTREAM_TOKEN"),
});

@WorkflowStart({ name: "deps-workflow-start", description: "A text", input: WorkflowStartTextDto })
class DepsStart {}

@WorkflowFinish({
  name: "deps-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
class DepsFinish {}

@Action({
  name: "deps-action",
  description: "Reads the upstream's settings",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [depsEnv],
})
class DepsAction {
  constructor(readonly config: InferEnv<typeof depsEnv>) {}

  execute(): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: this.config.upstream });
  }
}

@Workflow({
  name: "deps-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(DepsStart).toAction(DepsAction).toFinish(DepsFinish)],
})
class DepsWorkflow {}

@Application({
  name: "deps-application",
  version: "1.0.0",
  workflows: [DepsWorkflow],
  budgets: TEST_BUDGETS,
})
class DepsApplication {}

describe("#1324b: referencedVariablesOf walks a workflow's components' deps", () => {
  it("an action with deps: [appEnv] names the variables of that defineEnv", async () => {
    const found = referencedVariablesOf(await applicationOf(DepsApplication));

    expect(found.map((one) => [one.variable, one.use, one.field])).toEqual([
      ["DEPS_UPSTREAM_URL", "value", "DepsAction.deps.upstream"],
      ["DEPS_UPSTREAM_TOKEN", "secret", "DepsAction.deps.token"],
    ]);
  });
});
