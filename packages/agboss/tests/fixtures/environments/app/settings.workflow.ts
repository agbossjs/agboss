import {
  Agent,
  Injectable,
  Workflow,
  ENV,
  MODEL_MAX,
  type Environment,
  Tool,
  type ToolHandler,
  WorkflowFinish,
  WorkflowStart,
} from "../../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { start } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";

/** A service that reads the app's environment (#182). */
@Injectable({ deps: [ENV] })
export class ApiClient {
  constructor(readonly env: Environment) {}
}

export class SettingsQuery {
  @Text({ prompt: "what to look up" })
  what!: string;
}

export class SettingsInfo {
  @Text() apiUrl!: string;
  @Text() apiKey!: string;
  @Text() currency!: string;
}

@Tool({
  name: "api_settings",
  description: "The API settings of this app",
  input: SettingsQuery,
  output: SettingsInfo,
  deps: [ApiClient],
})
export class ApiSettings implements ToolHandler<SettingsQuery, SettingsInfo> {
  constructor(private readonly client: ApiClient) {}

  run(): Promise<SettingsInfo> {
    const { apiUrl, apiKey, currency } = this.client.env;
    return Promise.resolve({ apiUrl, apiKey, currency });
  }
}

@Agent({
  name: "clerk-agent",
  description: "Answers with the API settings",
  model: "test/clerk",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
  tools: [ApiSettings],
  promptUrls: ["./clerk.prompt.md"],
})
export class Clerk {}

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class ChatStart {}

@WorkflowFinish({
  name: "reply-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class Reply {}

export const settingsDefaults = {
  models: { temperature: 0, maxTokens: MODEL_MAX, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 4 },
  history: { limit: 4 },
} as const;

/** A workflow with `environments/` next to it: dev (defaults) and staging (required variables). */
@Workflow({
  name: "settings-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .toFinish(Reply),
  ],
  defaults: settingsDefaults,
  providers: [ApiClient],
})
export class SettingsApp {}

@Application({
  name: "settings-application",
  version: "1.0.0",
  workflows: [SettingsApp],
  budgets: TEST_BUDGETS,
})
export class SettingsApplication {}
