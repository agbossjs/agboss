import { Window4Memory } from "../../../helpers/window-memory.js";
import {
  Agent,
  Injectable,
  Workflow,
  ApplicationContext,
  TokenLimit,
  Tool,
  WorkflowFinish,
  WorkflowStart,
} from "../../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { onStart } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { SettingsEnvironment } from "./environments/app.environment.js";

/** A service that reads the application's environment (#182, #261: through `ApplicationContext`). */
@Injectable({ deps: [ApplicationContext] })
export class ApiClient {
  constructor(readonly applicationContext: ApplicationContext) {}

  get environment(): SettingsEnvironment {
    return this.applicationContext.environment;
  }
}

export class SettingsQuery {
  @Text({ prompt: "what to look up" })
  what!: string;
}

export class SettingsInfo {
  @Text() apiUrl!: string;
  @Text() currency!: string;
}

@Tool({
  name: "api-settings-tool",
  description: "The API settings of this app",
  input: SettingsQuery,
  output: SettingsInfo,
  deps: [ApiClient],
})
export class ApiSettings {
  constructor(private readonly client: ApiClient) {}

  execute(): Promise<SettingsInfo> {
    const { apiUrl, currency } = this.client.environment;
    return Promise.resolve({ apiUrl, currency });
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
  models: { temperature: 0, maxTokens: TokenLimit.ModelMax, cache: true },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 4 },
} as const;

/** A workflow whose application has `environments/` next to it: dev, staging and test. */
@Workflow({
  name: "settings-workflow",
  version: "1.0.0",
  flow: [onStart(ChatStart).toAgent(Clerk).toFinish(Reply)],
  defaults: settingsDefaults,
  memory: Window4Memory,
  providers: [ApiClient],
})
export class SettingsApp {}

@Application({
  name: "settings-application",
  version: "1.0.0",
  environment: SettingsEnvironment,
  workflows: [SettingsApp],
  budgets: TEST_BUDGETS,
})
export class SettingsApplication {}
