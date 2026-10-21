import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeKind } from "../../src/flow/ast.js";
import { start } from "../../src/flow/builder.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Agent, RagMode } from "../../src/flow/decorators/agent.js";
import { declarationOf, declared } from "../../src/flow/decorators/declaration.js";
import { agbossComponent, agbossDto } from "../../src/flow/generated-types.js";
import { DecidedBy, Router } from "../../src/flow/decorators/router.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { isWrapper, listOf, oneOf, optional } from "../../src/flow/dto-wrappers.js";
import { Injectable } from "../../src/components/decorators.js";
import { InjectionToken, provide } from "../../src/components/injection.js";
import { Reasoning, ReasoningEffort } from "../../src/models/reasoning.js";
import { DraftReviewerAgent, FinalReviewerAgent } from "./fixtures/article.fixture.js";
import { ChatWorkflow, MainRouter, ProfilerAgent } from "./fixtures/chat.fixture.js";
import {
  ArticleDto,
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  ShortlistDto,
} from "./fixtures/dtos.js";
import { EditorAgent, NotifyRecruiterAction, OfferWorkflow } from "./fixtures/offer.fixture.js";
import { OrderWorkflowFinish, OrderWorkflowStart } from "./fixtures/order.fixture.js";
import { reviewerAgentOptions } from "./fixtures/reviewer-agent.options.js";

/** What the v2 decorators record (#272 → Decorators v2, #270 → typed input / output). */

const thisFile = fileURLToPath(import.meta.url);

describe("v2 decorators record kind, options and the declaring file", () => {
  it("@Agent records its options as written", () => {
    expect(declarationOf(EditorAgent)).toEqual({
      kind: NodeKind.Agent,
      options: {
        name: "editor-agent",
        description: "Rewrites the draft by the review notes",
        prompt: "Rewrite the draft.",
        model: "moonshotai/kimi-k2.6",
        input: { draft: OfferDraftDto, changes: ChangesRequestedDto },
        output: OfferDraftDto,
        maxVisits: 2,
      },
      source: expect.stringMatching(/offer\.fixture\.ts$/),
    });
  });

  it("@WorkflowStart, @WorkflowFinish, @Action and @Router record their kinds", () => {
    expect(declarationOf(OrderWorkflowStart)?.kind).toBe(NodeKind.Start);
    expect(declarationOf(OrderWorkflowFinish)?.options).toMatchObject({
      name: "order-workflow-finish",
      input: { shipped: expect.any(Function) },
    });
    expect(declarationOf(NotifyRecruiterAction)?.kind).toBe(NodeKind.Action);
    expect(declarationOf(MainRouter)).toMatchObject({
      kind: NodeKind.Router,
      options: { name: "main-router", decidedBy: DecidedBy.Model, maxVisits: 3 },
    });
  });

  it("a class without a v2 decorator has no declaration", () => {
    @Injectable()
    class PlainService {}

    expect(declarationOf(PlainService)).toBeUndefined();
  });

  it("a declaration without a known file has no source", () => {
    expect(declared(NodeKind.Start, { name: "x" }, undefined)).toEqual({
      kind: NodeKind.Start,
      options: { name: "x" },
    });
  });

  it("the generated brands use their own symbols", () => {
    expect(typeof agbossComponent).toBe("symbol");
    expect(agbossDto).not.toBe(agbossComponent);
  });

  it("records the file the decorator was called from", () => {
    @WorkflowStart({ name: "local-workflow-start", description: "Here", input: ShortlistDto })
    class LocalWorkflowStart {}

    expect(declarationOf(LocalWorkflowStart)?.source).toBe(thisFile);
  });
});

describe("@Workflow records the flow as plain paths", () => {
  it("keeps each path's source and steps, not the builder objects", () => {
    const declaration = declarationOf(OfferWorkflow);

    expect(declaration?.kind).toBe(NodeKind.Workflow);
    const flow = declaration?.kind === NodeKind.Workflow ? declaration.options.flow : [];
    expect(flow).toHaveLength(2);
    expect(Object.keys(flow[0] ?? {})).toEqual(["source", "steps"]);
    expect(flow[0]?.source).toEqual({ kind: NodeKind.Start, node: expect.any(Function) });
    expect(declarationOf(ChatWorkflow)?.options).toMatchObject({
      name: "chat-workflow",
      version: "1.0.0",
    });
  });

  it("takes the limits and defaults", () => {
    @Workflow({
      name: "limited-workflow",
      version: "2.0.0",
      flow: [start(OrderWorkflowStart)],
      maxSteps: 12,
      maxDepth: 2,
      maxConcurrentExecutions: 4,
      defaults: {
        models: { temperature: 0, reasoning: Reasoning.off() },
        router: { model: "typesafe/jev-1.13" },
        flow: { maxPathDepth: 4 },
      },
      uncompactedTurns: 5,
    })
    class LimitedWorkflow {}

    expect(declarationOf(LimitedWorkflow)?.options).toMatchObject({
      maxSteps: 12,
      maxDepth: 2,
      maxConcurrentExecutions: 4,
      defaults: { router: { model: "typesafe/jev-1.13" }, flow: { maxPathDepth: 4 } },
    });
  });
});

describe("#261: @Workflow keeps its own services", () => {
  it("records providers: classes and provided values", () => {
    @Injectable()
    class OfferBook {}
    const OFFER_LIMIT = new InjectionToken<number>("OFFER_LIMIT");
    const limit = provide(OFFER_LIMIT, 3);

    @Workflow({
      name: "serviced-workflow",
      version: "1.0.0",
      flow: [start(OrderWorkflowStart)],
      providers: [OfferBook, limit],
    })
    class ServicedWorkflow {}

    expect(declarationOf(ServicedWorkflow)?.options).toMatchObject({
      providers: [OfferBook, limit],
    });
  });
});

describe("#270 AC3: input declares types only", () => {
  it("input declares types only", () => {
    const declaration = declarationOf(EditorAgent);
    const input = declaration?.kind === NodeKind.Agent ? declaration.options.input : undefined;

    for (const field of Object.values(input ?? {})) {
      expect(typeof field === "function" || isWrapper(field)).toBe(true);
    }
    expect(Object.keys(declaration?.options ?? {})).not.toEqual(
      expect.arrayContaining(["producedBy", "producedByAny", "producedByAll", "alsoTo"]),
    );
  });

  it("an action declares optional and list fields and a oneOf output", () => {
    @Action({
      name: "summarize-action",
      description: "Summarizes the reviews",
      input: {
        drafts: listOf(OfferDraftDto),
        approved: optional(DraftApprovedDto),
      },
      output: oneOf(ChangesRequestedDto, DraftApprovedDto),
    })
    class SummarizeAction {
      execute(): Promise<void> {
        return Promise.resolve();
      }
    }

    expect(declarationOf(SummarizeAction)?.options).toMatchObject({
      input: { drafts: listOf(OfferDraftDto), approved: optional(DraftApprovedDto) },
      output: oneOf(ChangesRequestedDto, DraftApprovedDto),
    });
  });
});

describe("AC16: two classes of one agent share an options const", () => {
  it("each class keeps its own name and the const's exact objects", () => {
    const draft = declarationOf(DraftReviewerAgent);
    const final = declarationOf(FinalReviewerAgent);

    expect(draft?.options.name).toBe("draft-reviewer-agent");
    expect(final?.options.name).toBe("final-reviewer-agent");
    expect(draft?.kind === NodeKind.Agent ? draft.options.input : undefined).toBe(
      reviewerAgentOptions.input,
    );
    expect(final?.kind === NodeKind.Agent ? final.options.input : undefined).toBe(
      reviewerAgentOptions.input,
    );
    expect(reviewerAgentOptions.input.article).toBe(ArticleDto);
  });
});

describe("AC13: the name is explicit, never derived from the class", () => {
  it("records the name as written, whatever the class is called", () => {
    @Agent({
      name: "score-summary-agent",
      description: "Sums the scores up",
      prompt: "Sum up.",
      model: "moonshotai/kimi-k2.6",
    })
    class RenamedLaterAgent {}

    expect(declarationOf(RenamedLaterAgent)?.options.name).toBe("score-summary-agent");
    expect(declarationOf(ProfilerAgent)?.options.name).toBe("profiler-agent");
  });
});

describe("#269 AC1 / AC2: enums and the one reasoning form", () => {
  it("records reasoning as a Reasoning value and rag modes as RagMode", () => {
    @Agent({
      name: "researcher-agent",
      description: "Researches",
      prompt: "Research.",
      model: "moonshotai/kimi-k2.6",
      reasoning: Reasoning.on({ effort: ReasoningEffort.Low }),
      rag: [{ use: EditorAgent, mode: RagMode.Context }],
    })
    class ResearcherAgent {}

    expect(declarationOf(ResearcherAgent)?.options).toMatchObject({
      reasoning: { kind: "on", effort: ReasoningEffort.Low },
      rag: [{ use: EditorAgent, mode: "context" }],
    });
  });

  it("a model router is decided by its model", () => {
    @Router({
      name: "review-router",
      description: "Routes the draft",
      decidedBy: DecidedBy.Model,
      input: { draft: OfferDraftDto },
      routes: [{ target: EditorAgent, prompt: "The draft needs edits" }],
    })
    class ReviewRouter {}

    expect(declarationOf(ReviewRouter)?.options).toMatchObject({ decidedBy: "model" });
  });

  it("a router takes its prompt from files and static variables", () => {
    @Router({
      name: "file-prompt-router",
      description: "Routes by a prompt file",
      decidedBy: DecidedBy.Model,
      promptUrls: ["./file-prompt.prompt.md"],
      promptVariables: { team: "recruiting" },
      input: { draft: OfferDraftDto },
      routes: [{ target: EditorAgent, prompt: "The draft needs edits" }],
    })
    class FilePromptRouter {}

    expect(declarationOf(FilePromptRouter)).toMatchObject({
      options: {
        promptUrls: ["./file-prompt.prompt.md"],
        promptVariables: { team: "recruiting" },
      },
      source: thisFile,
    });
  });
});

describe("@WorkflowFinish with input has a handler", () => {
  it("records input, output and deps", () => {
    @Injectable()
    class Formatter {}

    @WorkflowFinish({
      name: "formatted-workflow-finish",
      description: "Formats the draft",
      input: { draft: OfferDraftDto },
      output: OfferDraftDto,
      deps: [Formatter],
    })
    class FormattedWorkflowFinish {
      constructor(readonly formatter: Formatter) {}
      finish(): OfferDraftDto {
        return { text: "formatted" };
      }
    }

    expect(declarationOf(FormattedWorkflowFinish)?.options).toMatchObject({ deps: [Formatter] });
    expect(new FormattedWorkflowFinish(new Formatter()).finish()).toEqual({ text: "formatted" });
  });
});
