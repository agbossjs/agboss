/**
 * #708 — a model arbiter of a quorum reads each answer through the answering agent's PII policies,
 * whichever copy of the agent gave it: the copies `contact-answer-agent` and `contact-answer-agent#2`
 * are one agent with one set of policies (looked up by the agent's node, never by the copy's id —
 * an unknown element falls back to the workflow's policies, never to none). Its model reads the
 * address in each answer as a token.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  Agent,
  Arbiter,
  DecidedBy,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { Text, WorkflowStartTextDto } from "../../src/dto/index.js";
import { decideWith, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, start } from "../helpers/flow.js";
import { requestText, tokensIn } from "./boundary.helpers.js";
import { ContactPiiPolicy, PII_KEY_VARIABLE } from "./pii.fixture.js";

const EMAIL = "alice@example.com";

export class OwnerAnswerDto {
  @Text({ prompt: "who owns the rota, with their contact" })
  owner!: string;
}

export class OwnersDto {
  @Text({ prompt: "the owners named" })
  owners!: string;
}

@Agent({
  name: "contact-answer-agent",
  description: "Names the rota's owner",
  prompt: "Name the owner.",
  model: "local/llama",
  output: OwnerAnswerDto,
  piiPolicies: [ContactPiiPolicy],
})
class ContactAnswerAgent {}

@Arbiter({
  name: "contact-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer that names an owner.",
  criteria: [{ agent: ContactAnswerAgent, prompt: "Names the owner with a contact" }],
})
class ContactArbiter {}

@WorkflowStart({
  name: "owners-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
class OwnersStart {}

@WorkflowFinish({
  name: "owners-workflow-finish",
  description: "The owners",
  input: { answers: listOf(OwnerAnswerDto) },
  output: OwnersDto,
})
class OwnersFinish {
  finish(input: { readonly answers: readonly Produced<OwnerAnswerDto, unknown>[] }): OwnersDto {
    return { owners: input.answers.map((answer) => answer.value.owner).join("; ") };
  }
}

@Workflow({
  name: "owners-workflow",
  version: "1.0.0",
  flow: [
    start(OwnersStart)
      .returns(WorkflowStartTextDto)
      .toParallelAgents(ContactAnswerAgent, ContactAnswerAgent)
      .acceptedBy(ContactArbiter)
      .joinQuorum({ min: 2 })
      .returns(listOf(OwnerAnswerDto))
      .toFinish(OwnersFinish),
  ],
})
class OwnersWorkflow {}

@Application({
  name: "owners-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OwnersWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
class OwnersApplication {}

const test = testWith(OwnersApplication, {
  processEnv: { [PII_KEY_VARIABLE]: "test-key" },
} as never);

const read: string[] = [];
beforeEach(() => {
  read.length = 0;
});

describe("#708: a model arbiter reads every copy's answer through the agent's policies", () => {
  test("two copies of one agent: each answer reaches the arbiter's model with the address as a token", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ContactAnswerAgent).thenReturn(
      replyWith(OwnerAnswerDto, { owner: `Ann, ${EMAIL}` }),
      replyWith(OwnerAnswerDto, { owner: `Ann again, ${EMAIL}` }),
    );
    mockLlm(ContactArbiter).thenAnswer((request: ModelRequest) => {
      read.push(requestText(request));
      return decideWith({ counts: 0.9 });
    });

    const done = await execute(app, OwnersStart, { text: "Who owns the rota?" });

    expect(done.output).toEqual({ owners: `Ann, ${EMAIL}; Ann again, ${EMAIL}` });
    expect(read).toHaveLength(2);
    for (const text of read) {
      expect(text).not.toContain(EMAIL);
      expect(tokensIn(text, "email")).toHaveLength(1);
    }
  });
});
