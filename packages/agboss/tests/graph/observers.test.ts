import { describe, expect } from "vitest";
import {
  Workflow,
  Agent,
  OnWorkflowStart,
  AppState,
  OnAgentStart,
  type AgentStartEvent,
  Injectable,
  OnAgentEnd,
  type AgentEndEvent,
  WorkflowStart,
  WorkflowFinish,
  WorkflowSettings,
} from "../../src/index.js";
import { testWith, replyWith } from "../../src/testing/index.js";

const logs: string[] = [];

@Injectable()
class MyMetricsObserver implements OnWorkflowStart, OnAgentStart, OnAgentEnd {
  onWorkflowStart(state: AppState) {
    logs.push(`start-wf`);
  }
  onAgentStart(ctx: AgentStartEvent) {
    logs.push(`start-agent-${ctx.name}`);
  }
  onAgentEnd(ctx: AgentEndEvent) {
    logs.push(`end-agent-${ctx.name}`);
  }
}

@Agent({ name: "worker-agent", model: "stub", description: "worker" })
class WorkerAgent {}

import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";

@WorkflowStart({ name: "start-workflow-start", description: "Start", input: WorkflowStartTextDto })
class Start {}

@WorkflowFinish({
  name: "finish-workflow-finish",
  description: "Finish",
  output: WorkflowFinishTextDto,
})
class Finish {}

import { usd } from "../../src/units/index.js";
import { execute, start } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

@Workflow({
  name: "obs-wf-workflow",
  version: "1",
  defaults: {
    models: { temperature: 0, cache: true },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 1 },
    history: { limit: 1 },
  },
  flow: [start(Start).returns(WorkflowStartTextDto).toAgent(WorkerAgent).toFinish(Finish)],
  observers: [MyMetricsObserver],
})
class ObsWf {
  settings() {
    return WorkflowSettings.builder()
      .limits({
        perDay: { cost: usd(100) },
        perRun: { cost: usd(1) },
      })
      .build();
  }
}

@Application({
  name: "obs-wf-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ObsWf],
  budgets: TEST_BUDGETS,
})
export class ObsWfApplication {}

const test = testWith(ObsWfApplication);

describe("Observers", () => {
  test("triggers observer hooks", async ({ app, mockLlm }) => {
    mockLlm(WorkerAgent).thenReturn(replyWith("done"));
    logs.length = 0; // reset
    await execute(app, Start, { text: "hello" });
    expect(logs).toEqual(["start-wf", "start-agent-worker-agent", "end-agent-worker-agent"]);
  });
});
