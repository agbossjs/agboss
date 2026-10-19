import { Agent, Decision, Judge, Workflow, Router } from "../../../src/index.js";
import {
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "../../../src/index.js";
import { LUNA } from "./decision-judged.workflow.js";
import { PlainTextDto, Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { DecidedBy, WorkflowFinish } from "../../../src/index.js";
import { route, start } from "../../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS, Reply, TaskStart } from "./judged.workflow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** On a chat model, yet asks for a decision. */
@Judge({ name: "chat-decider", model: "local/judge", reply: PlainTextDto, deps: [JudgeModel] })
export class ChatDecider implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const a = await this.judgeModel.decide({
      state: reply.text,
      questions: { ok: Decision.noul("The reply is fine") },
    });
    return a.ok.noul > 0.5 ? JudgeVerdict.passed() : JudgeVerdict.failed({ reason: "not fine" });
  }
}

/** On a decision model, yet chats. */
@Judge({ name: "decision-chatter", model: LUNA, reply: PlainTextDto, deps: [JudgeModel] })
export class DecisionChatter implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const fine = (await this.judgeModel.invoke(`Is this fine? ${reply.text}`)) === "yes";
    return fine ? JudgeVerdict.passed() : JudgeVerdict.failed({ reason: "not fine" });
  }
}

@Agent({
  name: "chat-judged-agent",
  prompt: "Write.",
  description: "Judged by a chat model asked to decide",
  model: "local/llama",
  judges: [ChatDecider],
})
export class ChatJudged {}

@Agent({
  name: "decision-judged-agent",
  prompt: "Write.",
  description: "Judged by a decision model asked to chat",
  model: "local/llama",
  judges: [DecisionChatter],
})
export class DecisionJudged {}

@Workflow({
  name: "chat-decider-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ChatJudged)
      .toFinish(Reply),
  ],
  defaults: DEFAULTS,
})
export class ChatDeciderDesk {}

@Application({
  name: "chat-decider-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChatDeciderDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class ChatDeciderDeskApplication {}

@Workflow({
  name: "decision-chatter-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DecisionJudged)
      .toFinish(Reply),
  ],
  defaults: DEFAULTS,
})
export class DecisionChatterDesk {}

@Application({
  name: "decision-chatter-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
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
  prompt: "Read.",
  description: "Reads the ask",
  model: "local/llama",
  output: AskDto,
})
export class Intake {}

@Agent({ name: "coder-agent", prompt: "Code.", description: "Writes code", model: "local/llama" })
export class Coder {}

@WorkflowFinish({ name: "as-is-workflow-finish", description: "The ask, as is", output: AskDto })
export class AsIs {}

/** A router on GPT-6 Luna Decisions: a decision model that is not Jev. */
@Router({
  name: "triage-router",
  description: "Sends coding asks to the coder",
  decidedBy: DecidedBy.Model,
  prompt: "Who handles this?",
  model: LUNA,
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
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Intake)
      .returns(AskDto)
      .toRouter(Triage)
      .chooseOne(
        route(Coder)
          .toFinish(Reply),
        route(AsIs),
      ),
  ],
  defaults: DEFAULTS,
})
export class LunaRouted {}

@Application({
  name: "luna-routed-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LunaRouted],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class LunaRoutedApplication {}
