/**
 * #916 item 3 (option C), in an application: an `@A2AAgent({ target: { finishes } })` called from an
 * action whose task ends at another finish fails the step with `A2AUnexpectedFinishError`, which
 * `.onError` takes; `target.finishes` that no finish could match is `[a2a.unknown-finish]` at
 * assembly; `agboss describe` and `--json` show the list, and `check --federation` compares only the
 * listed finishes (`[federation.unknown-finish]` for one the receiver's start lacks).
 */
import { afterEach, describe, expect, it } from "vitest";
import { A2AAgent, A2AClient, A2AUnexpectedFinishError } from "../../../src/a2a/index.js";
import { createAppWith } from "../../../src/application/create-app.js";
import { Application } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import type { App } from "../../../src/app/types.js";
import type { Class } from "../../../src/components/injection.js";
import { a2aAgentLines } from "../../../src/describe/a2a-agents.js";
import { contractsOf } from "../../../src/describe/contracts.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { checkFederation, FederationProblemCode } from "../../../src/federation/federation.js";
import {
  Action,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../src/index.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { execute, start, toFinish } from "../../helpers/flow.js";
import { offline } from "../fixtures/remote.workflow.js";
import {
  FileSummaryWorkflow,
  FilesApplication,
  ReviewRequestDto,
  ReviewResultDto,
} from "../fixtures/files.application.js";
import { agentEndingAt, AnswerDto } from "./support/finishes-agent.js";
import { AGENT_URL } from "./support/sdk-agent.js";

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const agent = agentEndingAt("hand-over-workflow-finish");

@A2AAgent({
  name: "answers-a2a-agent",
  url: AGENT_URL,
  target: { finishes: ["answer-workflow-finish"] },
  input: WorkflowStartTextDto,
  output: AnswerDto,
})
class AnswersA2AAgent extends A2AClient<WorkflowStartTextDto, AnswerDto> {
  constructor() {
    super({ fetcher: agent.fetcher });
  }
}

@Action({
  name: "ask-peer-action",
  description: "Asks the peer",
  input: { question: WorkflowStartTextDto },
  output: AnswerDto,
  deps: [AnswersA2AAgent],
})
class AskPeerAction {
  constructor(private readonly peer: AnswersA2AAgent) {}

  execute(input: { readonly question: Produced<WorkflowStartTextDto, unknown> }) {
    return this.peer.execute({ text: input.question.value.text });
  }
}

@WorkflowStart({
  name: "ask-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
class AskWorkflowStart {}

@WorkflowFinish({ name: "answered-workflow-finish", description: "The answer", output: AnswerDto })
class AnsweredFinish {}

@WorkflowFinish({
  name: "handed-over-workflow-finish",
  description: "The peer ended elsewhere: the question, set aside",
  output: WorkflowStartTextDto,
})
class HandedOverFinish {}

@Workflow({
  name: "ask-workflow",
  version: "1.0.0",
  flow: [
    start(AskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(AskPeerAction)
      .onError(A2AUnexpectedFinishError, toFinish(HandedOverFinish))
      .returns(AnswerDto)
      .toFinish(AnsweredFinish),
  ],
  providers: [AnswersA2AAgent],
})
class AskWorkflow {}

@Application({
  name: "ask-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AskWorkflow],
  budgets: TEST_BUDGETS,
})
class AskApplication {}

describe("#916 item 3: an unexpected finish in an execution", () => {
  it("AC3.8 the step fails with A2AUnexpectedFinishError and .onError takes it", async () => {
    const app = await createAppWith(AskApplication, offline(new ScriptBook()));
    apps.push(app);

    const result = await execute(app, AskWorkflowStart, { text: "hi" });

    const [handled] = result.handledErrors;
    const codes: string[] = [];
    for (let error = handled?.error; error !== undefined; error = error.cause)
      codes.push(error.code);

    expect(result.finish?.name).toBe("handed-over-workflow-finish");
    expect(codes).toContain("a2a.unexpected-finish");
    expect(result.output).toEqual({ text: "hi" });
  });

  it("AC3.9 describe and --json show the finishes the client takes", async () => {
    const assembled = await applicationOf(AskApplication);

    expect(a2aAgentLines(assembled)).toEqual([
      "a2a agents",
      `  answers-a2a-agent → ${AGENT_URL} · finishes: answer-workflow-finish · mesh: not guaranteed (foreign peer)`,
    ]);
  });
});

/** An application that consumes files-application's review with `finishes`, for federation. */
function consumerOf(finishes: readonly string[] | undefined): Class {
  @A2AAgent({
    name: "review-a2a-agent",
    url: AGENT_URL,
    target: {
      application: "files-application",
      skill: "file-review-workflow-start",
      ...(finishes === undefined ? {} : { finishes }),
    },
    input: ReviewRequestDto,
    output: ReviewResultDto,
  })
  class ReviewA2AAgent extends A2AClient<ReviewRequestDto, ReviewResultDto> {}

  @Application({
    name: "review-consumer-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [FileSummaryWorkflow],
    providers: [ReviewA2AAgent],
    budgets: TEST_BUDGETS,
  })
  class ReviewConsumerApplication {}
  return ReviewConsumerApplication;
}

const memberOf = async (application: Class) => {
  const assembled = await applicationOf(application);
  return {
    name: assembled.name,
    version: assembled.version,
    file: `${assembled.name}.json`,
    contracts: contractsOf(assembled),
  };
};

const federationCodesOf = async (finishes: readonly string[] | undefined) => {
  const consumer = await memberOf(consumerOf(finishes));
  const report = checkFederation(consumer, [await memberOf(FilesApplication)]);
  return { consumer, codes: report.problems.map((problem) => problem.code) };
};

describe("#916 item 3: target.finishes in --json and check --federation", () => {
  it("AC3.10 every finish by default (incompatible), the listed one only (none), an unknown one", async () => {
    const all = await federationCodesOf(undefined);
    const narrowed = await federationCodesOf(["file-review-workflow-finish"]);
    const unknown = await federationCodesOf(["refund-workflow-finish"]);

    expect(all.codes).toEqual([FederationProblemCode.IncompatibleSchema]);
    expect(narrowed.codes).toEqual([]);
    expect(unknown.codes).toEqual([FederationProblemCode.UnknownFinish]);
    expect(narrowed.consumer.contracts.imports).toMatchObject([
      { target: { finishes: ["file-review-workflow-finish"] } },
    ]);
    expect(all.consumer.contracts.imports[0]?.target).not.toHaveProperty("finishes");
  });
});

class PlainAnswerDto {
  @Text({ prompt: "the answer" })
  text!: string;
}

describe("#916 item 3: target.finishes at assembly", () => {
  it("AC3.11 no finish name, a name twice, an empty list, an untyped agent: [a2a.unknown-finish]", async () => {
    @A2AAgent({
      name: "named-a2a-agent",
      url: AGENT_URL,
      target: { finishes: ["answer", "a-workflow-finish", "a-workflow-finish"] },
      input: WorkflowStartTextDto,
      output: PlainAnswerDto,
    })
    class NamedA2AAgent extends A2AClient<WorkflowStartTextDto, PlainAnswerDto> {}

    @A2AAgent({
      name: "empty-a2a-agent",
      url: AGENT_URL,
      target: { finishes: [] },
      input: WorkflowStartTextDto,
      output: PlainAnswerDto,
    })
    class EmptyA2AAgent extends A2AClient<WorkflowStartTextDto, PlainAnswerDto> {}

    @A2AAgent({
      name: "untyped-a2a-agent",
      url: AGENT_URL,
      target: { finishes: ["a-workflow-finish"] },
    })
    class UntypedA2AAgent extends A2AClient {}

    @Application({
      name: "finishes-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [AskWorkflow],
      providers: [NamedA2AAgent, EmptyA2AAgent, UntypedA2AAgent],
      budgets: TEST_BUDGETS,
    })
    class FinishesApplication {}

    const message = await applicationOf(FinishesApplication).catch((error: unknown) =>
      String(error),
    );

    expect(message).toContain(
      `[a2a.unknown-finish] named-a2a-agent's target.finishes "answer" is no @WorkflowFinish name`,
    );
    expect(message).toContain(
      `named-a2a-agent's target.finishes "a-workflow-finish" is listed twice`,
    );
    expect(message).toContain("empty-a2a-agent's target.finishes lists no finish");
    expect(message).toContain(
      "untyped-a2a-agent's target.finishes lists finishes but has no output DTO",
    );
  });
});
