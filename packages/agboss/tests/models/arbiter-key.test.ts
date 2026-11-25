import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Arbiter,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Action,
  inline,
  Ttl,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { Text, WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  BackupModelProvider,
  LocalModelProvider,
  TestOpenRouterProvider,
} from "./providers.fixture.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toAgent } from "../helpers/flow.js";
import { providerStub } from "./stub.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

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
  modelProvider: LocalModelProvider,
  output: AnsDto,
})
class AnsAgent {}

@Arbiter({
  name: "ans-arbiter",
  model: "moonshotai/kimi-k2.6",
  modelProvider: TestOpenRouterProvider,
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
  async execute(i: { readonly answers: readonly Tracked<AnsDto>[] }): Promise<OutDto> {
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
  modelProvider: TestModelProvider,
  version: "1.0.0",
  historyTtl: Ttl.Forever,
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

    await expect(started).rejects.toBeInstanceOf(ConfigError.Environment);
    await expect(started).rejects.toThrow(/OPENROUTER_API_KEY is not set/);
  });
});
