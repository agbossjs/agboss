import { Agent, Application, Tool, Workflow, inline, Ttl } from "../../../../src/index.js";
import type { InferEnv } from "../../../../src/index.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import { profileEnv } from "./app.env.js";
import { built, PingDto, PingFinish, PingStart } from "./profile-env.application.js";

/** A tool that needs a real address to be built: on a placeholder its constructor throws. */
@Tool({
  name: "fussy-tool",
  description: "Parses its address when built",
  input: PingDto,
  output: PingDto,
  deps: [profileEnv],
})
export class FussyTool {
  constructor(config: InferEnv<typeof profileEnv>) {
    built.push(new URL(config.required).href);
  }

  execute(): Promise<PingDto> {
    return Promise.resolve({});
  }
}

@Agent({
  name: "fussy-agent",
  description: "Fusses",
  prompt: inline("Fuss."),
  model: "test/fussy",
  tools: [FussyTool],
})
export class FussyAgent {}

@Workflow({
  name: "fussy-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(PingStart).toAgent(FussyAgent).toFinish(PingFinish)],
})
export class FussyWorkflow {}

/** The same environment on a tool whose constructor cannot take a placeholder. */
@Application({
  name: "fussy-application",
  version: "1.0.0",
  workflows: [FussyWorkflow],
  budgets: TEST_BUDGETS,
  modelProvider: TestModelProvider,
})
export class FussyApplication {}
