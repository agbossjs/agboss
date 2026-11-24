/**
 * #1366: the input rules of a flow (#270), by code and by the node each refusal names: a required field no path brings
 * (and one the branch of a join may not have answered), an optional one no path produces, one field where one step
 * brought several values (from a start, from a join), a `historyOf` field that a join's list does not fill, two fields
 * reading one class, a `historyOf maxPrevious that is no positive integer, and a node reached by too many scopes. Each is
 * refused with the code and the node, a clean flow passes.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../../src/flow/analyse/analyse.js";
import { Agent } from "../../../../src/flow/decorators/agent.js";
import { Workflow, type WorkflowOptions } from "../../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../src/flow/decorators/workflow-start.js";
import { historyOf, listOf, oneOf, optional, Wrapper } from "../../../../src/flow/dto-wrappers.js";
import { PauseExpiredError } from "../../../../src/flow/runtime/pause-expired-error.js";
import { ScreeningFailedDto } from "../../../flow/fixtures/launch-dtos.js";
import { Action } from "../../../../src/flow/decorators/action.js";
import {
  OfferDraftDto,
  OfferSentDto,
  ReviewDto,
  ShortlistDto,
  UnrelatedDto,
} from "../../../flow/fixtures/dtos.js";
import { DraftKitWorkflowFinish, KitWorkflowStart } from "../../../flow/fixtures/kit.fixture.js";
import {
  ArticleDraftWorkflowFinish,
  ArticleWriterAgent,
  CriticAgent,
  PlannerAgent,
  PlanResearcherAgent,
  ResearchWorkflowStart,
  ScreeningFailedWorkflowFinish,
} from "../../../flow/fixtures/launch.fixture.js";
import { ArticleDraftDto } from "../../../flow/fixtures/launch-dtos.js";
import { CritiqueDto, ResearchDto } from "../../../flow/fixtures/review-dtos.js";
import { onStart, toAction } from "../../../flow/fixtures/paths.js";
import { MAX_SCOPES_PER_NODE } from "../../../../src/flow/analyse/dataflow.js";
import { toFinish } from "../../../flow/fixtures/paths.js";
import { inline } from "../../../../src/index.js";

type Flow = WorkflowOptions["flow"];

let count = 0;
const workflowWith = (flow: Flow): abstract new () => unknown => {
  count += 1;
  @Workflow({ name: `inputs-case-${String(count)}-workflow`, version: "1.0.0", flow })
  class InputsCaseWorkflow {}
  return InputsCaseWorkflow;
};

/** What the input rules refuse: code, the nodes it names, and the message to tell two of a class apart. */
const refusals = (flow: Flow) =>
  checkWorkflow(workflowWith(flow))
    .errors.filter((found) =>
      /^(input|flow\.ambiguous-field|flow\.analysis-too-large)/.test(found.code),
    )
    .map(({ code, nodes, message }) => ({ code, nodes, message }));

const codesAndNodes = (flow: Flow) => refusals(flow).map(({ code, nodes }) => ({ code, nodes }));

const agentOf = (name: string, input: Record<string, unknown>) => {
  @Agent({
    name,
    description: "Reads its input",
    prompt: inline("Read it."),
    model: "moonshotai/kimi-k2.6",
    input: input as never,
    output: OfferDraftDto,
  })
  class ReadsAgent {}
  return ReadsAgent;
};

const kit = () => onStart(KitWorkflowStart);

describe("#1366: a field no path brings", () => {
  it("a required field is [input.missing-on-path], an optional one [input.never-produced], both name the node", () => {
    const reader = agentOf("needs-unrelated-1366h-agent", {
      shortlist: ShortlistDto,
      unrelated: UnrelatedDto,
      maybe: optional(OfferSentDto),
    });

    expect(codesAndNodes([kit().toAgent(reader).toFinish(DraftKitWorkflowFinish)])).toEqual([
      { code: "input.missing-on-path", nodes: ["needs-unrelated-1366h-agent"] },
      { code: "input.never-produced", nodes: ["needs-unrelated-1366h-agent"] },
    ]);
  });

  it("a flow whose every field is brought passes", () => {
    const reader = agentOf("reads-shortlist-1366h-agent", { shortlist: ShortlistDto });

    expect(refusals([kit().toAgent(reader).toFinish(DraftKitWorkflowFinish)])).toEqual([]);
  });
});

describe("#1366: several values where one field reads", () => {
  it("two values of one class from a start refuse the single field, naming the node", () => {
    @WorkflowStart({
      name: "contract-1366h-workflow-start",
      description: "Two reviews of one class",
      input: { legal: ReviewDto, compliance: ReviewDto },
    })
    class ContractStart {}
    @WorkflowFinish({
      name: "contract-1366h-workflow-finish",
      description: "Done",
      output: ShortlistDto,
    })
    class ContractFinish {}
    @Agent({
      name: "contract-summary-1366h-agent",
      description: "Sums the review up",
      prompt: inline("Sum up."),
      model: "moonshotai/kimi-k2.6",
      input: { review: ReviewDto },
      output: ShortlistDto,
    })
    class SummaryAgent {}

    const flow: Flow = [onStart(ContractStart).toAgent(SummaryAgent).toFinish(ContractFinish)];

    expect(refusals(flow)).toEqual([
      expect.objectContaining({
        code: "input.several-on-path",
        nodes: ["contract-summary-1366h-agent"],
        message: expect.stringMatching(/brings 2 values on the path/) as unknown,
      }),
    ]);
  });
});

/** A planner's parallel agents joined: a research and two critiques (a list of one class), read by `reader`. */
const joinedInto = (reader: abstract new () => unknown): Flow => [
  onStart(ResearchWorkflowStart)
    .toAgent(PlannerAgent)
    .toParallelAgents(PlanResearcherAgent, CriticAgent, CriticAgent)
    .join()
    .toAgent(reader)
    .toFinish(ArticleDraftWorkflowFinish),
];

const readerOf = (name: string, input: Record<string, unknown>) => {
  @Agent({
    name,
    description: "Reads the critique",
    prompt: inline("Read it."),
    model: "moonshotai/kimi-k2.6",
    input: input as never,
    output: ArticleDraftDto,
  })
  class CritiqueReader {}
  return CritiqueReader;
};

describe("#1366: a join's list read by a single field", () => {
  it("is [input.several-on-path] naming the node, told apart by who brings several", () => {
    const flow = joinedInto(readerOf("single-critique-1366h-agent", { critique: CritiqueDto }));

    expect(refusals(flow)).toEqual([
      expect.objectContaining({
        code: "input.several-on-path",
        nodes: ["single-critique-1366h-agent"],
        message: expect.stringMatching(/critic-agent brings several CritiqueDto values/) as unknown,
      }),
    ]);
  });

  it("does not make a historyOf field several: it is not produced, nothing more", () => {
    const flow = joinedInto(
      readerOf("history-critique-1366h-agent", { critique: historyOf(CritiqueDto) }),
    );

    expect(codesAndNodes(flow)).toEqual([
      { code: "input.missing-on-path", nodes: ["history-critique-1366h-agent"] },
    ]);
  });

  it("a listOf field reading the list passes", () => {
    const flow = joinedInto(
      readerOf("list-critique-1366h-agent", { critiques: listOf(CritiqueDto) }),
    );

    expect(refusals(flow)).toEqual([]);
  });
});

@Action({
  name: "settled-required-1366h-action",
  description: "Reads the research as if it always came",
  input: { research: ResearchDto },
  output: ScreeningFailedDto,
})
class SettledRequiredAction {
  execute(_input: unknown): Promise<never> {
    return Promise.reject(new Error("not run"));
  }
}

describe("#1366: a side path of a join error reads a settled answer", () => {
  it("as required it is [input.missing-on-path] for an answer its branch may not have given, naming the node", () => {
    const flow: Flow = [
      onStart(ResearchWorkflowStart)
        .toAgent(PlannerAgent)
        .toParallelAgents(PlanResearcherAgent, CriticAgent, CriticAgent, { maxConcurrency: 3 })
        .join()
        .onError(
          PauseExpiredError,
          toAction(SettledRequiredAction).toFinish(ScreeningFailedWorkflowFinish),
        )
        .toAgent(ArticleWriterAgent)
        .toFinish(ArticleDraftWorkflowFinish),
    ];

    expect(refusals(flow)).toEqual([
      expect.objectContaining({
        code: "input.missing-on-path",
        nodes: ["settled-required-1366h-action"],
        message: expect.stringMatching(/may not have answered/) as unknown,
      }),
    ]);
  });
});

describe("#1366: two fields reading one class, a bad historyOf maxPrevious", () => {
  it("two fields of one class are [flow.ambiguous-field] naming the node", () => {
    const reader = agentOf("twice-1366h-agent", { first: ShortlistDto, second: ShortlistDto });

    expect(codesAndNodes([kit().toAgent(reader).toFinish(DraftKitWorkflowFinish)])).toEqual([
      { code: "flow.ambiguous-field", nodes: ["twice-1366h-agent"] },
    ]);
  });

  it.each([[0], [1.5], [-2]])(
    "a historyOf maxPrevious of %s is [input.history-max-previous] naming the node",
    (maxPrevious) => {
      const reader = agentOf("limit-1366h-agent", {
        shortlist: historyOf(ShortlistDto, { maxPrevious }),
      });

      expect(codesAndNodes([kit().toAgent(reader).toFinish(DraftKitWorkflowFinish)])).toEqual([
        { code: "input.history-max-previous", nodes: ["limit-1366h-agent"] },
      ]);
    },
  );

  it("a positive integer maxPrevious, or none, passes", () => {
    const limited = agentOf("limited-1366h-agent", {
      shortlist: historyOf(ShortlistDto, { maxPrevious: 2 }),
    });
    const unlimited = agentOf("unlimited-1366h-agent", { shortlist: historyOf(ShortlistDto) });

    expect(refusals([kit().toAgent(limited).toFinish(DraftKitWorkflowFinish)])).toEqual([]);
    expect(refusals([kit().toAgent(unlimited).toFinish(DraftKitWorkflowFinish)])).toEqual([]);
  });
});

/** 13 optional fields of a start: 2^13 = 8192 reachable scopes at the finish. */
const manyDtos = Array.from({ length: 13 }, (_, index) => {
  const name = `Field${String(index + 1)}Dto`;
  return {
    [name]: class {
      value!: string;
    },
  }[name];
}).filter((dto) => dto !== undefined);

describe("#1366: a node reached by too many scopes", () => {
  const fields = Object.fromEntries(
    manyDtos.map((dto, index) => [`field${String(index + 1)}`, optional(dto)]),
  );
  @WorkflowStart({
    name: "wide-1366h-workflow-start",
    description: "A base value and many optional fields",
    input: { base: ShortlistDto, ...fields },
  })
  class WideStart {}
  @Action({
    name: "wide-1366h-action",
    description: "Reads them all",
    input: fields,
    output: ShortlistDto,
  })
  class WideAction {
    async execute(): Promise<ShortlistDto> {
      return { candidates: "" };
    }
  }

  @WorkflowFinish({
    name: "wide-1366h-workflow-finish",
    description: "Reads them all",
    output: ShortlistDto,
  })
  class WideFinish {}
  const wide: Flow = [onStart(WideStart).toAction(WideAction).toFinish(WideFinish)];

  it(`more than ${String(MAX_SCOPES_PER_NODE)} scopes at a node are [flow.analysis-too-large] naming the node`, () => {
    expect(codesAndNodes(wide)).toEqual([
      { code: "flow.analysis-too-large", nodes: ["wide-1366h-action"] },
    ]);
  });

  it("names the slots that multiply the scopes, not the one that is the same in all of them", () => {
    const slots = manyDtos
      .map((dto) => dto.name)
      .sort()
      .join(", ");
    const [refused] = refusals(wide);

    expect(refused?.message).toContain(`the slots ${slots} multiply them`);
  });
});

const researchAgent = (
  name: string,
  input: Record<string, unknown>,
  output: abstract new () => unknown,
) => {
  @Agent({
    name,
    description: "Works",
    prompt: inline("Work."),
    model: "moonshotai/kimi-k2.6",
    input: input as never,
    output: output as never,
  })
  class WorkAgent {}
  return WorkAgent;
};

describe("#1366: a field whose latest value is outdated", () => {
  /** A draft built from the research, then the research renewed: the latest draft is outdated. */
  const staleDraftThen = (reader: abstract new () => unknown): Flow => [
    kit()
      .toAgent(
        researchAgent("stale-research-1366h-agent", { shortlist: ShortlistDto }, ResearchDto),
      )
      .toAgent(researchAgent("stale-draft-1366h-agent", { research: ResearchDto }, OfferDraftDto))
      .toAgent(researchAgent("stale-again-1366h-agent", { shortlist: ShortlistDto }, ResearchDto))
      .toAgent(reader)
      .toFinish(DraftKitWorkflowFinish),
  ];

  it("a plain field is refused as outdated only, not also as not produced", () => {
    const reader = agentOf("plain-draft-1366h-agent", { draft: OfferDraftDto });

    expect(codesAndNodes(staleDraftThen(reader))).toEqual([
      { code: "input.outdated-on-path", nodes: ["plain-draft-1366h-agent"] },
    ]);
  });

  it("a historyOf field has no current value there: [input.missing-on-path]", () => {
    const reader = agentOf("history-draft-1366h-agent", { drafts: historyOf(OfferDraftDto) });

    expect(codesAndNodes(staleDraftThen(reader))).toEqual([
      { code: "input.missing-on-path", nodes: ["history-draft-1366h-agent"] },
    ]);
  });
});

describe("#1366: a oneOf field no path brings", () => {
  it("is optional, so only [input.never-produced] naming the node, whatever a join's list holds", () => {
    const flow = joinedInto(
      readerOf("either-critique-1366h-agent", { critique: oneOf(CritiqueDto, UnrelatedDto) }),
    );

    expect(codesAndNodes(flow)).toEqual([
      { code: "input.never-produced", nodes: ["either-critique-1366h-agent"] },
    ]);
  });
});

describe("#1366: a oneOf field beside two lists of its classes", () => {
  it("is never several: the lists are no value of it", () => {
    const either = oneOf(CritiqueDto, UnrelatedDto);
    @WorkflowStart({
      name: "lists-1366h-workflow-start",
      description: "Two lists of one of two classes",
      input: { first: listOf(either), second: listOf(either) },
    })
    class ListsStart {}
    const reader = agentOf("either-lists-1366h-agent", { either });
    const flow: Flow = [onStart(ListsStart).toAgent(reader).toFinish(DraftKitWorkflowFinish)];

    expect(codesAndNodes(flow)).toEqual([
      { code: "input.never-produced", nodes: ["either-lists-1366h-agent"] },
    ]);
  });
});

describe("#1366: a class is a class, whatever static members it has", () => {
  it("a DTO class with a static kind and inner reads as itself, not as the wrapper it looks like", () => {
    class LooksOptionalDto {
      static readonly kind = Wrapper.Optional;
      static readonly inner = CritiqueDto;
      value!: string;
    }
    const flow = joinedInto(readerOf("looks-1366h-agent", { weird: LooksOptionalDto }));

    expect(codesAndNodes(flow)).toEqual([
      { code: "input.missing-on-path", nodes: ["looks-1366h-agent"] },
    ]);
  });
});
