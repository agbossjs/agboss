/**
 * #708 — a model judge in an agent's quality gate reads as the agent's model reads: the text its
 * `judge()` sends goes through the agent's PII policies, and the reply's tokens come back as values,
 * so the judge's code sees the address and its model never does.
 */
import { describe, expect } from "vitest";
import {
  Agent,
  EmptyEnvironment,
  Judge,
  JudgeModel,
  JudgeVerdict,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type JudgeHandler,
  type JudgeInput,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { PlainTextDto, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { requestText, tokensIn } from "../pii/boundary.helpers.js";
import { ContactPiiPolicy } from "../pii/pii.fixture.js";
import { DEFAULTS, MODEL_PROVIDERS } from "./fixtures/judged.workflow.js";

const EMAIL = "alice@example.com";
const seen: string[] = [];

/** Asks its model whether the reply is fine; keeps what the model said, as `judge()` got it. */
@Judge({ name: "contact-judge", model: "local/judge", reply: PlainTextDto, deps: [JudgeModel] })
class ContactJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`Is this reply fine? ${reply.text}`);
    seen.push(said);
    return JudgeVerdict.passed();
  }
}

@Agent({
  name: "contact-writer-agent",
  prompt: "Write.",
  description: "Writes an answer",
  model: "local/llama",
  judges: [ContactJudge],
  piiPolicies: [ContactPiiPolicy],
})
class ContactWriter {}

@WorkflowStart({
  name: "contact-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
class ContactStart {}

@WorkflowFinish({
  name: "contact-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
class ContactFinish {}

@Workflow({
  name: "contact-workflow",
  version: "1.0.0",
  flow: [
    start(ContactStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ContactWriter)
      .toFinish(ContactFinish),
  ],
  defaults: DEFAULTS,
})
class ContactWorkflow {}

@Application({
  name: "contact-judge-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ContactWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
class ContactJudgeApplication {}

const test = testWith(ContactJudgeApplication);

describe("#708: a model judge reads as its agent's model reads", () => {
  test("its model reads the address as a token; judge() reads the reply revealed", async ({
    app,
    mockLlm,
  }) => {
    seen.length = 0;
    mockLlm(ContactWriter).thenReturn(replyWith(`Write to ${EMAIL}.`));
    // the judge's model echoes what it read: the token, which the framework reveals for judge()
    mockLlm(ContactJudge).thenReturn(replyWith("ECHO"));

    await app.execute(ContactStart, { text: "Who handles on-call?" });

    const read = requestText(mockLlm(ContactJudge).onlyRequest);
    expect(read).not.toContain(EMAIL);
    expect(tokensIn(read, "email")).toHaveLength(1);
    expect(seen).toEqual(["ECHO"]);
  });
});
