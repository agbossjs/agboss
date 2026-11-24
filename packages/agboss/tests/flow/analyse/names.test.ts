import { describe, expect, it } from "vitest";
import { Text } from "../../../src/dto/index.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { ShortlistDto } from "../fixtures/dtos.js";
import { KitWorkflowStart } from "../fixtures/kit.fixture.js";
import { onStart } from "../fixtures/paths.js";
import { analyseWorkflow } from "../../../src/flow/analyse/analyse.js";

/** Names (#272 AC13; #270 AC14, S5): kind suffixes, the `Dto` suffix, unique DTO names. */

class Critique {
  @Text({ prompt: "the critique" })
  notes!: string;
}

@Agent({
  name: "score-summary",
  description: "Sums the scores up",
  prompt: "Sum up.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: Critique,
})
class ScoreSummaryAgent {}

@WorkflowFinish({
  name: "critique-workflow-finish",
  description: "The critique",
  output: Critique,
})
class CritiqueWorkflowFinish {}

@Workflow({
  name: "offer",
  version: "1.0.0",
  flow: [onStart(KitWorkflowStart).toAgent(ScoreSummaryAgent).toFinish(CritiqueWorkflowFinish)],
})
class BadlyNamedWorkflow {}

/** Renamed from `ScoreSummaryAgent` — its name, the key of records, did not change. */
@Agent({
  name: "rank-summary-agent",
  description: "Sums the ranks up",
  prompt: "Sum up.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: ShortlistDto,
})
class RenamedLaterAgent {}

@WorkflowFinish({
  name: "shortlist-workflow-finish",
  description: "The shortlist",
  output: ShortlistDto,
})
class ShortlistWorkflowFinish {}

@Workflow({
  name: "renamed-workflow",
  version: "1.0.0",
  flow: [onStart(KitWorkflowStart).toAgent(RenamedLaterAgent).toFinish(ShortlistWorkflowFinish)],
})
class RenamedWorkflow {}

/** Two DTO classes named `ResultDto`, from two modules. */
const searchResult = (() => {
  class ResultDto {
    @Text({ prompt: "a search result" })
    hit!: string;
  }
  return ResultDto;
})();

const offerResult = (() => {
  class ResultDto {
    @Text({ prompt: "an offer result" })
    offer!: string;
  }
  return ResultDto;
})();

@Agent({
  name: "search-agent",
  description: "Searches",
  prompt: "Search.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: searchResult,
})
class SearchAgent {}

@WorkflowFinish({
  name: "result-workflow-finish",
  description: "The other result",
  output: offerResult,
})
class ResultWorkflowFinish {}

@Workflow({
  name: "clashing-dtos-workflow",
  version: "1.0.0",
  flow: [onStart(KitWorkflowStart).toAgent(SearchAgent).toFinish(ResultWorkflowFinish)],
})
class ClashingDtosWorkflow {}

describe("AC13: every name ends with its kind", () => {
  it("kind suffix: names the decorator and the name to use", () => {
    const messages = checkWorkflow(BadlyNamedWorkflow)
      .errors.filter((found) => found.code === "name.kind-suffix")
      .map((found) => found.message);

    expect(messages).toEqual([
      'offer: "offer" on @Workflow — name it "offer-workflow"',
      'offer: "score-summary" on @Agent — name it "score-summary-agent"',
    ]);
  });

  it("the graph is keyed by name, which survives a class rename", () => {
    expect([...analyseWorkflow(RenamedWorkflow).graph.nodes.keys()]).toContain(
      "rank-summary-agent",
    );
  });
});

describe("#270 AC14: dto name", () => {
  it("a DTO used as an output or in without the Dto suffix fails", () => {
    expect(checkWorkflow(BadlyNamedWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "dto.name",
        message: "offer: Critique is a DTO — name it CritiqueDto",
      }),
    );
  });

  it("two DTO classes with one name fail, naming both files (S5)", () => {
    const modules = [
      { file: "src/search/result.dto.ts", exports: { ResultDto: searchResult } },
      { file: "src/offer/result.dto.ts", exports: { ResultDto: offerResult } },
    ];

    expect(checkWorkflow(ClashingDtosWorkflow, { modules }).errors).toContainEqual(
      expect.objectContaining({
        code: "dto.duplicate-name",
        message:
          "clashing-dtos-workflow: ResultDto is declared in src/offer/result.dto.ts and src/search/result.dto.ts — DTO names are unique in the application (they key checkpoints)",
      }),
    );
  });
});
