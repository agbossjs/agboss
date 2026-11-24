import { describe, expect, it } from "vitest";
import {
  Agent,
  Arbiter,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
  Action,
  inline,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { Text, WorkflowStartTextDto } from "../../src/dto/index.js";
import { EnvironmentError } from "../../src/environments/errors.js";
import {
  BackupModelProvider,
  LocalModelProvider,
  TestOpenRouterProvider,
} from "./providers.fixture.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toAgent } from "../helpers/flow.js";
import { providerStub } from "./stub.js";

class AnsDto {
  @Text({ prompt: "a" }) a!: string;
}
class OutDto {
  @Text({ prompt: "o" }) o!: string;
}

@Agent({
  name: "ans-agent",
  description: "A",
  prompt: inline("A."),
  model: "local/llama",
  output: AnsDto,
})
class AnsAgent {}

@Arbiter({
  name: "ans-arbiter",
  model: "moonshotai/kimi-k2.6",
  prompt: inline("Count it."),
  criteria: [{ target: AnsAgent, prompt: "ok" }],
})
class AnsArbiter {}

@WorkflowStart({ name: "ans-start-workflow-start", description: "q", input: WorkflowStartTextDto })
class AnsStart {}

@Action({
  name: "ans-finish-action",
  description: "f",
  input: { answers: listOf(AnsDto) },
  output: OutDto,
})
class AnsAction {
  async execute(i: { readonly answers: readonly Produced<AnsDto, unknown>[] }): Promise<OutDto> {
    return { o: String(i.answers.length) };
  }
}

@WorkflowFinish({
  name: "ans-finish-workflow-finish",
  description: "f",
  output: OutDto,
})
class AnsFinish {}

@Workflow({
  name: "ans-workflow",
  version: "1.0.0",
  flow: [
    onStart(AnsStart)
      .inParallel([toAgent(AnsAgent), toAgent(AnsAgent)])
      .arbitratedBy(AnsArbiter)
      .joinQuorum({ min: 2 })
      .toAction(AnsAction)
      .toFinish(AnsFinish),
  ],
})
class AnsWorkflow {}

@Application({
  name: "ans-app-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AnsWorkflow],
  providers: [LocalModelProvider, TestOpenRouterProvider, BackupModelProvider],
  budgets: TEST_BUDGETS,
})
class AnsAppApplication {}

describe("#716: an arbiter-only provider", () => {
  it("still fails at createApp without the OpenRouter key", async () => {
    const started = createTestAppWith(AnsAppApplication, {
      processEnv: {},
      providerFetch: providerStub([], [{ id: "local/llama" }]).fetch,
    });

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/no openRouterApiKey/);
  });
});
