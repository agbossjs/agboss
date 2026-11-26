import {
  Agent,
  Application,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../../../src/index.js";
import type { InferEnv } from "../../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import { otherEnv, profileEnv } from "./app.env.js";

/** Every `upstream` a tool of this application was built with, in order (a test reads and clears it). */
export const built: string[] = [];

export class PingDto {}

/** A tool on `deps: [profileEnv]`: its constructor records the address it got. */
@Tool({
  name: "ping-tool",
  description: "Pings the upstream",
  input: PingDto,
  output: PingDto,
  deps: [profileEnv],
})
export class PingTool {
  constructor(config: InferEnv<typeof profileEnv>) {
    built.push(config.upstream);
  }

  execute(): Promise<PingDto> {
    return Promise.resolve({});
  }
}

/** Reads the same variable as `profileEnv.upstream`, but with no default: the variable is required. */
@Tool({
  name: "second-tool",
  description: "Reads the upstream without a default",
  input: PingDto,
  output: PingDto,
  deps: [otherEnv],
})
export class SecondTool {
  constructor(readonly config: InferEnv<typeof otherEnv>) {}

  execute(): Promise<PingDto> {
    return Promise.resolve({});
  }
}

@Agent({
  name: "ping-agent",
  description: "Pings",
  prompt: inline("Ping."),
  model: "test/ping",
  tools: [PingTool, SecondTool],
})
export class PingAgent {}

@WorkflowStart({ name: "ping-workflow-start", description: "A text", input: WorkflowStartTextDto })
class PingStart {}

@WorkflowFinish({
  name: "ping-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
class PingFinish {}

@Workflow({
  name: "ping-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(PingStart).toAgent(PingAgent).toFinish(PingFinish)],
})
export class PingWorkflow {}

@Application({
  name: "ping-application",
  version: "1.0.0",
  workflows: [PingWorkflow],
  budgets: TEST_BUDGETS,
  modelProvider: TestModelProvider,
})
export class PingApplication {}

export { PingStart, PingFinish };
