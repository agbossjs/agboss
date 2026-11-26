import { Agent, Decision, Judge, Workflow, Router, inline, Ttl } from "../../../src/index.js";
import {
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "../../../src/index.js";
import { LUNA } from "./decision-judged.workflow.js";
import { PlainTextDto, Text } from "../../../src/dto/index.js";
import { DecidedBy, WorkflowFinish } from "../../../src/index.js";
import { onStart, toAgent, toFinish } from "../../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS, Reply, TaskStart } from "./judged.workflow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";
import { LocalModelProvider, TestDecisionsProvider } from "../../models/providers.fixture.js";

/** On a chat model, yet asks for a decision. */
@Judge({ name: "chat-decider", model: "local/judge", output: PlainTextDto, deps: [JudgeModel] })
export class ChatDecider implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const a = await this.judgeModel.decide({
      state: output.text,
      questions: { ok: Decision.boolean("The reply is fine") },
    });
    return a.ok.probability > 0.5 ? JudgeVerdict.passed() : JudgeVerdict.failed("not fine");
  }
}

/** On a decision model, yet chats. */
@Judge({
  name: "decision-chatter",
  model: LUNA,
  modelProvider: TestDecisionsModelProvider,
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class DecisionChatter implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const fine = (await this.judgeModel.invoke(`Is this fine? ${output.text}`)) === "yes";
    return fine ? JudgeVerdict.passed() : JudgeVerdict.failed("not fine");
  }
}

@Agent({
  name: "chat-judged-agent",
  prompt: inline("Write."),
  description: "Judged by a chat model asked to decide",
  model: "local/llama",
  judges: [ChatDecider],
})
export class ChatJudged {}

@Agent({
  name: "decision-judged-agent",
  prompt: inline("Write."),
  description: "Judged by a decision model asked to chat",
  model: "local/llama",
  judges: [DecisionChatter],
})
export class DecisionJudged {}

@Workflow({
  name: "chat-decider-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart).toAgent(ChatJudged).toFinish(Reply)],
  defaults: DEFAULTS,
})
export class ChatDeciderDesk {}

@Application({
  name: "chat-decider-desk-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [ChatDeciderDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class ChatDeciderDeskApplication {}

@Workflow({
  name: "decision-chatter-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(TaskStart).toAgent(DecisionJudged).toFinish(Reply)],
  defaults: DEFAULTS,
})
export class DecisionChatterDesk {}

@Application({
  name: "decision-chatter-desk-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [DecisionChatterDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class DecisionChatterDeskApplication {}

/** What the intake read the ask as. */
export class AskDto {
  @Text({ prompt: "the ask" })
  text!: string;
}

@Agent({
  name: "intake-agent",
  prompt: inline("Read."),
  description: "Reads the ask",
  model: "local/llama",
  output: AskDto,
})
export class Intake {}

@Agent({
  name: "coder-agent",
  prompt: inline("Code."),
  description: "Writes code",
  model: "local/llama",
})
export class Coder {}

@WorkflowFinish({ name: "as-is-workflow-finish", description: "The ask, as is", output: AskDto })
export class AsIs {}

/** A router on GPT-6 Luna Decisions: a decision model that is not Jev. */
@Router({
  name: "triage-router",
  description: "Sends coding asks to the coder",
  decidedBy: DecidedBy.Model,
  prompt: inline("Who handles this?"),
  model: LUNA,
  // the real Decisions wire (a base URL and a key): the wire test reads what goes out
  modelProvider: TestDecisionsProvider,
  input: { ask: AskDto },
  routes: [
    { prompt: "A coding ask", target: Coder },
    { prompt: "Anything else: reply as is", target: AsIs },
  ],
})
export class Triage {}

@Workflow({
  name: "luna-routed-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart)
      .toAgent(Intake)
      .toRouter(Triage)
      .onRoute(toAgent(Coder).toFinish(Reply))
      .onRoute(toFinish(AsIs)),
  ],
  defaults: DEFAULTS,
})
export class LunaRouted {}

@Application({
  name: "luna-routed-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [LunaRouted],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class LunaRoutedApplication {}
