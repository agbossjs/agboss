import { describe, expect, it } from "vitest";
import { Text } from "../../../src/dto/index.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { answerToolName } from "../../../src/flow/analyse/rules/models.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { ProfileDto, ShortlistDto } from "../fixtures/dtos.js";
import { KitWorkflowStart } from "../fixtures/kit.fixture.js";
import { OfferWorkflow } from "../fixtures/offer.fixture.js";
import { onStart } from "../fixtures/paths.js";
import { inline } from "../../../src/index.js";

/** Answer tools of agents with `output` (#272 S6): their names and the model's tool calling. */

class ShortlistOfTheBestCandidatesWithTheirScoresAndTheReviewersNotesDto {
  @Text({ prompt: "the candidates" })
  candidates!: string;
}

@Agent({
  name: "long-answer-agent",
  description: "Answers with a long class name",
  prompt: inline("Answer."),
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: ShortlistOfTheBestCandidatesWithTheirScoresAndTheReviewersNotesDto,
})
class LongAnswerAgent {}

@WorkflowFinish({
  name: "long-workflow-finish",
  description: "The long answer",
  output: ShortlistOfTheBestCandidatesWithTheirScoresAndTheReviewersNotesDto,
})
class LongWorkflowFinish {}

@Workflow({
  name: "long-answer-workflow",
  version: "1.0.0",
  flow: [onStart(KitWorkflowStart).toAgent(LongAnswerAgent).toFinish(LongWorkflowFinish)],
})
class LongAnswerWorkflow {}

describe("AC11: answer tools of agents with output (S6)", () => {
  it("an answer tool is named after its DTO class", () => {
    expect(answerToolName(ProfileDto)).toBe("answer-profile-dto");
  });

  it("an answer tool name over 64 characters fails", () => {
    expect(checkWorkflow(LongAnswerWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "tool.name-too-long",
        message:
          "long-answer-workflow: long-answer-agent: the answer tool answer-shortlist-of-the-best-candidates-with-their-scores-and-the-reviewers-notes-dto has 85 characters (at most 64) — give its DTO class a shorter name",
      }),
    ]);
  });

  it("an agent with output on a model that cannot call tools fails", () => {
    const canCallTools = (model: string): boolean => model !== "moonshotai/kimi-k2.6";
    const messages = checkWorkflow(OfferWorkflow, { canCallTools }).errors.map(
      (found) => found.message,
    );

    expect(messages).toContain(
      "offer-workflow: draft-agent has output: OfferDraftDto, but moonshotai/kimi-k2.6 cannot call tools — pick a model that can",
    );
    expect(checkWorkflow(OfferWorkflow, { canCallTools: () => true }).errors).toEqual([]);
  });
});
