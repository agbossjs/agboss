/**
 * #1343 (#1283): `onArbiterStart` / `onArbiterEnd` — a quorum launch's arbiter judges each answer
 * in its branch's step; the observers hear a start and an end for every answer, with the verdict
 * and what it cost, and never an answer's text (the answers here carry an address).
 */
import { beforeEach, describe, expect } from "vitest";
import {
  Action,
  Agent,
  Arbiter,
  inline,
  listOf,
  Observer,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ArbiterEndEvent,
  type ArbiterStartEvent,
  type Tracked,
  Ttl,
} from "../../../src/index.js";
import { ArbiterOutcome } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { decideWith, replyWith, testWith } from "../../../src/testing/index.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { execute, onStart, toAgent } from "../../helpers/flow.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";

const EMAIL = "alice@example.com";

class RotaAnswerDto {
  @Text({ prompt: "who owns the rota, with their contact" })
  owner!: string;
}

class RotaOwnersDto {
  @Text({ prompt: "the owners named" })
  owners!: string;
}

@Agent({
  name: "rota-answer-agent",
  description: "Names the rota's owner",
  prompt: inline("Name the owner."),
  model: "local/llama",
  output: RotaAnswerDto,
})
class RotaAnswerAgent {}

@Arbiter({
  name: "rota-arbiter",
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  prompt: inline("Count an answer that names an owner."),
  criteria: [{ target: RotaAnswerAgent, prompt: "Names the owner with a contact" }],
})
class RotaArbiter {}

@WorkflowStart({
  name: "rota-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
class RotaStart {}

@Action({
  name: "rota-owners-action",
  description: "The owners",
  input: { answers: listOf(RotaAnswerDto) },
  output: RotaOwnersDto,
})
class RotaOwnersAction {
  async execute(input: {
    readonly answers: readonly Tracked<RotaAnswerDto>[];
  }): Promise<RotaOwnersDto> {
    return { owners: input.answers.map((answer) => answer.owner).join("; ") };
  }
}

@WorkflowFinish({ name: "rota-workflow-finish", description: "The owners", output: RotaOwnersDto })
class RotaFinish {}

@Workflow({
  name: "rota-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RotaStart)
      .inParallel([toAgent(RotaAnswerAgent), toAgent(RotaAnswerAgent)])
      .arbitratedBy(RotaArbiter)
      .joinQuorum({ min: 2 })
      .toAction(RotaOwnersAction)
      .toFinish(RotaFinish),
  ],
})
class RotaWorkflow {}

const events: (ArbiterStartEvent | ArbiterEndEvent)[] = [];

@Observer()
class ArbiterWatch {
  onArbiterStart(event: ArbiterStartEvent): void {
    events.push(event);
  }

  onArbiterEnd(event: ArbiterEndEvent): void {
    events.push(event);
  }
}

@Application({
  name: "rota-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  workflows: [RotaWorkflow],
  providers: MODEL_PROVIDERS,
  observers: [ArbiterWatch],
  budgets: TEST_BUDGETS,
})
class RotaApplication {}

const test = testWith(RotaApplication);

beforeEach(() => {
  events.length = 0;
});

describe("#1343: onArbiterStart / onArbiterEnd", () => {
  test("each judged answer has a start and an end, the verdict and the spend, in its step", async ({
    app,
    mockModel,
  }) => {
    mockModel(RotaAnswerAgent).thenReturn(
      replyWith(RotaAnswerDto, { owner: `Ann, ${EMAIL}` }),
      replyWith(RotaAnswerDto, { owner: "Bob" }),
    );
    mockModel(RotaArbiter).thenReturn(decideWith({ counts: 0.9 }), decideWith({ counts: 0.8 }));

    await execute(app, RotaStart, { text: "Who owns the rota?" });

    const starts = events.filter((event) => !("outcome" in event));
    const ends = events.filter((event): event is ArbiterEndEvent => "outcome" in event);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        arbiter: "rota-arbiter",
        target: expect.stringMatching(/^rota-answer-agent/),
        isCode: false,
        workflow: { name: "rota-workflow" },
      });
      expect(event.step.component.name).toBe("rota-answer-agent");
    }
    expect(ends.map((end) => end.outcome)).toEqual([
      ArbiterOutcome.Accepted,
      ArbiterOutcome.Accepted,
    ]);
  });

  test("an answer the arbiter rejects ends Rejected", async ({ app, mockModel }) => {
    mockModel(RotaAnswerAgent).thenReturn(replyWith(RotaAnswerDto, { owner: "Ann" }));
    mockModel(RotaArbiter).thenReturn(decideWith({ counts: 0.1 }));

    // one rejection and a quorum of two cannot be reached: the other answer is never judged
    await execute(app, RotaStart, { text: "Who owns the rota?" }).catch(() => undefined);

    const ends = events.filter((event): event is ArbiterEndEvent => "outcome" in event);
    expect(ends.map((end) => end.outcome)).toEqual([ArbiterOutcome.Rejected]);
    expect(events.filter((event) => !("outcome" in event))).toHaveLength(1);
  });

  test("an event shows names and numbers, never the answer it judged", async ({
    app,
    mockModel,
  }) => {
    mockModel(RotaAnswerAgent).thenReturn(
      replyWith(RotaAnswerDto, { owner: `Ann, ${EMAIL}` }),
      replyWith(RotaAnswerDto, { owner: `Ann again, ${EMAIL}` }),
    );
    mockModel(RotaArbiter).thenReturn(decideWith({ counts: 0.9 }), decideWith({ counts: 0.9 }));

    await execute(app, RotaStart, { text: "Who owns the rota?" });

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(EMAIL);
  });
});
