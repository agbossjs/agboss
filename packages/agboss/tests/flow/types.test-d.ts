import { describe, expectTypeOf, it } from "vitest";
import type { FlowPath } from "../../src/flow/ast.js";
import type { IsOneOf } from "../../src/flow/builder-types.js";
import {
  onAgent,
  onAction,
  caseOf,
  route,
  onRouter,
  onStart,
  toAction,
  toAgent,
  toFinish,
  toRouter,
  onWorkflow,
} from "../../src/flow/builder.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Agent, type AgentOptions } from "../../src/flow/decorators/agent.js";
import {
  DecidedBy,
  FailurePolicy,
  Router,
  SpawnPolicy,
  type CodeRouterOptions,
  type ModelRouterOptions,
  type RouteChecked,
} from "../../src/flow/decorators/router.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import type { WorkflowStartOptions } from "../../src/flow/decorators/workflow-start.js";
import {
  historyOf,
  isVariant,
  listOf,
  oneOf,
  optional,
  variant,
  type Produced,
  type HistoryOf,
  type HistoryOptions,
  type ValueOf,
} from "../../src/flow/dto-wrappers.js";
import { agbossComponent, type NodeKind } from "../../src/flow/generated-types.js";
import type {
  InputOf,
  MissingGeneratedTypes,
  OutputOf,
  ProducerOutputOf,
  Route,
  RouterAnswerOf,
} from "../../src/flow/generated-types.js";
import type { ActionHandler, RouterHandler } from "../../src/flow/handlers.js";
import { CreditOrderDto } from "./fixtures/credit-dtos.js";
import {
  ApprovalAgent,
  ChargeCardAction,
  CreditLimitRouter,
  OrderHeldWorkflowFinish,
  OrderIntakeAgent,
} from "./fixtures/credit.fixture.js";
import {
  DeliveryTopicAgent,
  OrderTopicAgent,
  RefundTopicAgent,
  TopicsRouter,
} from "./fixtures/topics.fixture.js";
import { Reasoning, ReasoningEffort } from "../../src/models/reasoning.js";
import {
  ChatWorkflowFinish,
  IntakeWorkflowStart,
  MainRouter,
  NoReplyWorkflowFinish,
  ProfilerAgent,
  ScoutAgent,
} from "./fixtures/chat.fixture.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ProfileDto,
  ResumeMissingDto,
  ReviewDto,
  ShortlistDto,
  UnrelatedDto,
} from "./fixtures/dtos.js";
import {
  BrokenAgent,
  DraftAgent,
  EditorAgent,
  NotifyRecruiterAction,
  OfferSentWorkflowFinish,
  OfferWorkflow,
  OfferWorkflowStart,
  ReviewerAgent,
  SendOfferAction,
  VisitsLimitExceededError,
} from "./fixtures/offer.fixture.js";
import { Text } from "../../src/dto/index.js";
import {
  ExecutionContext,
  type JudgeHandler,
  type JudgeInput,
  type StepDescriptor,
  type ToolHandler,
  inline,
} from "../../src/index.js";
import { testExecutionContext } from "../../src/testing/execution-context.js";

class NoteQueryDto {
  @Text({ prompt: "the note" })
  text!: string;
}
import { reviewerAgentOptions } from "./fixtures/reviewer-agent.options.js";
import { DraftChangesDto } from "./fixtures/data-dtos.js";
import { ApprovalDto, CritiqueDto, DraftDto } from "./fixtures/review-dtos.js";
import { CritiqueAction, StoryReviewerAgent } from "./fixtures/review.fixture.js";
import { ItemBlindAgent } from "./fixtures/broken-launch.fixture.js";
import {
  CompanyDto,
  CustomerReplyDto as HelpDeskReplyDto,
  OrderStatusDto,
} from "./fixtures/data-dtos.js";
import {
  AnswerAgent,
  ArticleWriterAgent,
  ChargePaymentAction,
  CompanyAuditAgent,
  CriticAgent,
  HelpDeskRouter,
  LoyaltyOfferAgent,
  NotifyOperatorAction,
  OffersRouter,
  OrderLookupAgent,
  PaymentWorkflowFinish,
  PlanResearcherAgent,
  PlannerAgent,
  RankerAgent,
  RefundPolicyAgent,
  ReserveGoodsAction,
  ScreeningAgent,
  ScreeningFailedWorkflowFinish,
  SendReceiptAction,
  UpdateCrmAction,
} from "./fixtures/launch.fixture.js";
import {
  CompanyGradeDto,
  CompanyRejectedDto,
  CompanyReviewFailedDto,
  JobOfferDto,
} from "./fixtures/child-dtos.js";
import {
  CompanyFinderAgent,
  CompanyPickerAgent,
  CompanyReviewWorkflow,
  JobOfferAgent,
  JobOfferWorkflowFinish,
  NoOfferFailedWorkflowFinish,
  NoOfferRejectedWorkflowFinish,
  ReviewErrorWorkflowFinish,
  ReviewRankerAgent,
} from "./fixtures/children.fixture.js";
import { TwinGradeWorkflow } from "./fixtures/broken-children.fixture.js";
import { StepFailedError } from "../../src/graph/errors.js";
import { LimitExceededError } from "../../src/graph/limits.js";

/**
 * Compile-time checks of the v2 flow (#272 PR 1, S3). Checked by `tsc` (the gate's typecheck), not
 * run by Vitest. Each `@ts-expect-error` is a negative test: tsc fails this file if the line
 * compiles. The types come from `.agboss/types.d.ts`, generated for the fixtures by `check:types`.
 */

/** A component the generated types do not know yet (no brand): every check names the fix. */
@Agent({
  name: "fresh-agent",
  description: "Added after the last agboss check",
  prompt: inline("Do it."),
  model: "moonshotai/kimi-k2.6",
})
class FreshAgent {}

describe("AC1: a path starts with its source's kind", () => {
  it("a source of the wrong kind does not compile", () => {
    onStart(OfferWorkflowStart);
    onAgent(ReviewerAgent);
    onRouter(MainRouter);
    onAction(SendOfferAction);
    // @ts-expect-error — MainRouter is not an agent
    onAgent(MainRouter);
    // @ts-expect-error — DraftAgent is not a workflow start
    onStart(DraftAgent);
    // @ts-expect-error — DraftAgent is not a router
    onRouter(DraftAgent);
    // @ts-expect-error — DraftAgent is not an action
    onAction(DraftAgent);
    expectTypeOf(onStart(OfferWorkflowStart)).toExtend<FlowPath>();
  });
});

describe("AC2: transitions name the target's kind", () => {
  it("a target of the wrong kind does not compile", () => {
    const shortlist = onStart(OfferWorkflowStart);
    shortlist.toAgent(DraftAgent);
    // @ts-expect-error — MainRouter is not an agent
    shortlist.toAgent(MainRouter);
    // @ts-expect-error — DraftAgent is not a router
    shortlist.toRouter(DraftAgent);
    // @ts-expect-error — DraftAgent is not an action
    shortlist.toAction(DraftAgent);
    // @ts-expect-error — DraftAgent is not a workflow finish
    shortlist.toFinish(DraftAgent);
    // @ts-expect-error — a route target is an agent, an action, a router or a finish
    route(OfferWorkflowStart);
    expectTypeOf(shortlist).toHaveProperty("toAgent");
  });

  it("returns is checked against output", () => {
    onStart(OfferWorkflowStart);
    onStart(OfferWorkflowStart).toAgent(DraftAgent);
    expectTypeOf<ProducerOutputOf<DraftAgent>>().toEqualTypeOf<OfferDraftDto>();
  });

  it("a next node that cannot take what the path carries does not compile", () => {
    const drafted = onStart(OfferWorkflowStart).toAgent(DraftAgent);
    // @ts-expect-error — broken-agent's generated input reports [input.missing-on-path]
    drafted.toAgent(BrokenAgent);
    expectTypeOf<InputOf<BrokenAgent>>().toHaveProperty("__error");
  });
});

describe("S3: before generation every check names the fix", () => {
  it("an unbranded class resolves to the diagnostic type", () => {
    // @ts-expect-error — Missing generated types — run `agboss check`
    onAgent(FreshAgent);
    // @ts-expect-error — Missing generated types — run `agboss check`
    onStart(OfferWorkflowStart).toAgent(FreshAgent);
    expectTypeOf<InputOf<FreshAgent>>().toEqualTypeOf<MissingGeneratedTypes>();
    expectTypeOf<OutputOf<FreshAgent>>().toEqualTypeOf<MissingGeneratedTypes>();
  });
});

describe("AC15 (#1270): .returns is gone — values are derived from the declarations", () => {
  it("no step offers .returns; what a step gives continues the path at once", () => {
    const drafted = onStart(OfferWorkflowStart).toAgent(DraftAgent);
    drafted.toAgent(ReviewerAgent);
    // @ts-expect-error — .returns(…) is removed (#1270)
    drafted.returns(OfferDraftDto);
    // @ts-expect-error — .returns(…) is removed after a start too
    onStart(OfferWorkflowStart).returns(ShortlistDto);
    const notified = toAction(NotifyRecruiterAction);
    notified.toFinish(OfferSentWorkflowFinish);
    expectTypeOf(notified).not.toHaveProperty("returns");
    expectTypeOf(drafted).not.toHaveProperty("returns");
    expectTypeOf(drafted).toHaveProperty("toAgent");
  });

  it("a oneOf output is switched, any other output continues", () => {
    expectTypeOf<IsOneOf<ChangesRequestedDto | DraftApprovedDto>>().toEqualTypeOf<true>();
    expectTypeOf<IsOneOf<OfferDraftDto>>().toEqualTypeOf<false>();
    expectTypeOf<IsOneOf<OfferDraftDto | undefined>>().toEqualTypeOf<false>();
    expectTypeOf<
      IsOneOf<readonly (ChangesRequestedDto | DraftApprovedDto)[]>
    >().toEqualTypeOf<false>();
    expectTypeOf(onAgent(ReviewerAgent)).toHaveProperty("switch");
    expectTypeOf(onAgent(ReviewerAgent)).not.toHaveProperty("toAgent");
    expectTypeOf(onAgent(DraftAgent)).not.toHaveProperty("switch");
  });
});

describe("AC5:.switch(caseOf(…)) after a oneOf output (#299 S54 c)", () => {
  it("caseOf outside oneOf does not compile, nor a missing case", () => {
    const reviewed = onAgent(ReviewerAgent);
    reviewed.switch(
      caseOf(ChangesRequestedDto).toAgent(EditorAgent),
      caseOf(DraftApprovedDto).toAction(SendOfferAction),
    );
    reviewed.switch(
      // @ts-expect-error — OfferSentDto is not an output of reviewer-agent
      caseOf(OfferSentDto).toAction(SendOfferAction),
      caseOf(ChangesRequestedDto).toAgent(EditorAgent),
      caseOf(DraftApprovedDto).toAction(SendOfferAction),
    );
    // @ts-expect-error — the switch is not exhaustive: DraftApprovedDto has no case
    reviewed.switch(caseOf(ChangesRequestedDto).toAgent(EditorAgent));
    // @ts-expect-error — a single output is returned, not switched
    onAgent(DraftAgent).switch(caseOf(OfferDraftDto).toAgent(ReviewerAgent));
    expectTypeOf<ProducerOutputOf<ProfilerAgent>>().toEqualTypeOf<ProfileDto | ResumeMissingDto>();
  });
});

describe("AC6: a router continues with chooseOne(route(…)…)", () => {
  it("chooseOne takes routes only", () => {
    onRouter(MainRouter).chooseOne(route(ScoutAgent).toFinish(ChatWorkflowFinish));
    // @ts-expect-error — chooseOne takes route(…) paths, not caseOf(…)
    onRouter(MainRouter).chooseOne(caseOf(ProfileDto).toRouter(MainRouter));
    expectTypeOf(onRouter(MainRouter)).toHaveProperty("chooseOne");
  });
});

describe("1278a: .onRoute(subPath) names each route of the router once", () => {
  const path = (flow: FlowPath): FlowPath => flow;
  const desk = () => onRouter(MainRouter);

  it("the chain is a path only when every route of @Router({ routes }) is named", () => {
    path(
      desk()
        .onRoute(toAgent(ProfilerAgent))
        .onRoute(toAgent(ScoutAgent).toFinish(ChatWorkflowFinish))
        .onRoute(toFinish(NoReplyWorkflowFinish)),
    );
    path(
      desk()
        .onRoute(toFinish(NoReplyWorkflowFinish))
        .onRoute(toAgent(ScoutAgent))
        .onRoute(toAgent(ProfilerAgent)),
    );
    path(
      // @ts-expect-error — NoReplyWorkflowFinish has no .onRoute
      desk().onRoute(toAgent(ProfilerAgent)).onRoute(toAgent(ScoutAgent)),
    );
  });

  it("a route is named once, and only a target of the router is a route", () => {
    desk()
      .onRoute(toAgent(ProfilerAgent))
      // @ts-expect-error — ProfilerAgent is named once
      .onRoute(toAgent(ProfilerAgent));
    // @ts-expect-error — DraftAgent is no route of MainRouter
    desk().onRoute(toAgent(DraftAgent));
  });

  it("a router's .onError comes before its routes, a sub-path chain is a nested route set", () => {
    path(
      desk()
        .onError(Error, toFinish(NoReplyWorkflowFinish))
        .onRoute(toAgent(ProfilerAgent))
        .onRoute(toAgent(ScoutAgent))
        .onRoute(toFinish(NoReplyWorkflowFinish)),
    );
    onStart(IntakeWorkflowStart)
      .toRouter(MainRouter)
      .onRoute(toAgent(ProfilerAgent))
      .onRoute(toAgent(ScoutAgent))
      .onRoute(toFinish(NoReplyWorkflowFinish));
    // @ts-expect-error — only a router has routes
    onAgent(EditorAgent).onRoute(toAgent(ProfilerAgent));
  });
});

describe("AC7: .onError stands right after the step that throws", () => {
  it("onError takes a toAction side path and does not follow .returns", () => {
    const edited = onAgent(EditorAgent).onError(
      VisitsLimitExceededError,
      toAction(NotifyRecruiterAction),
    );
    // @ts-expect-error — the side path is toAction(…)…, not a route
    onAgent(EditorAgent).onError(VisitsLimitExceededError, route(EditorAgent));
    expectTypeOf(edited).toHaveProperty("toAgent");
  });
});

describe("AC7: a side path starts with any transition, kinds checked", () => {
  it("toAction, toAgent, toRouter and toFinish begin a side path", () => {
    const edited = onAgent(EditorAgent)
      .onError(VisitsLimitExceededError, toFinish(OfferSentWorkflowFinish))
      .onError(Error, toAgent(DraftAgent).toAgent(ReviewerAgent))
      .onError(
        RangeError,
        toRouter(MainRouter).chooseOne(route(ScoutAgent).toFinish(ChatWorkflowFinish)),
      );
    // @ts-expect-error — MainRouter is not an agent
    toAgent(MainRouter);
    // @ts-expect-error — DraftAgent is not a router
    toRouter(DraftAgent);
    // @ts-expect-error — DraftAgent is not a workflow finish
    toFinish(DraftAgent);
    const finished = toFinish(OfferSentWorkflowFinish);
    // @ts-expect-error — nothing follows a finish
    finished.toAgent(DraftAgent);
    expectTypeOf(edited).toHaveProperty("toAgent");
  });
});

describe("#270 AC22: wrappers compose one way", () => {
  it("listOf(optional) does not compile; optional(listOf) does", () => {
    expectTypeOf(optional(listOf(OfferDraftDto)).inner.element).toEqualTypeOf<
      typeof OfferDraftDto
    >();
    // @ts-expect-error — a list element is never absent
    listOf(optional(OfferDraftDto));
    // @ts-expect-error — oneOf needs two classes or more
    oneOf(OfferDraftDto);
  });
});

describe("#299 S54 / S56: about is the flow's, historyOf an input's", () => {
  it("historyOf names one DTO class and a maxPrevious; only an input field takes it", () => {
    expectTypeOf(historyOf(DraftDto, { maxPrevious: 2 }).dto).toEqualTypeOf<typeof DraftDto>();
    expectTypeOf<HistoryOptions>().toEqualTypeOf<{ readonly maxPrevious?: number }>();
    expectTypeOf<ValueOf<ReturnType<typeof historyOf<typeof DraftDto>>>>().toEqualTypeOf<
      HistoryOf<DraftDto>
    >();
    // @ts-expect-error — historyOf names one class, not a list
    historyOf(listOf(DraftDto));
    // @ts-expect-error — a history always has its current value: never optional
    optional(historyOf(DraftDto));
    // @ts-expect-error — a list element is a class or a oneOf
    listOf(historyOf(DraftDto));
    // @ts-expect-error — maxPrevious is a number of versions
    historyOf(DraftDto, { maxPrevious: "2" });
    // @ts-expect-error — the option is maxPrevious, `limit` is gone (#1285)
    historyOf(DraftDto, { limit: 2 });
  });

  it("a component declares a plain output; historyOf is no output and no start input", () => {
    @Agent({
      name: "typed-critic-agent",
      description: "Critiques",
      prompt: inline("Critique it."),
      model: "moonshotai/kimi-k2.6",
      input: { drafts: historyOf(DraftDto, { maxPrevious: 3 }) },
      output: listOf(CritiqueDto),
    })
    class TypedCriticAgent {}
    expectTypeOf(TypedCriticAgent).toBeConstructibleWith();
    @Agent({
      name: "history-output-agent",
      description: "Bad",
      prompt: inline("Answer."),
      model: "moonshotai/kimi-k2.6",
      // @ts-expect-error — an output is a value: historyOf is read, never answered
      output: historyOf(DraftDto),
    })
    class HistoryOutputAgent {}
    expectTypeOf(HistoryOutputAgent).toBeConstructibleWith();
    const startOptions: WorkflowStartOptions = {
      name: "history-workflow-start",
      description: "Bad",
      // @ts-expect-error — a start takes values: there is nothing earlier yet
      input: { drafts: historyOf(DraftDto) },
    };
    expectTypeOf(startOptions.name).toEqualTypeOf<string>();
  });

  it("OutputOf<X> is the declared output; { about } in the flow changes provenance, never the value", () => {
    expectTypeOf<OutputOf<CritiqueAction>>().toEqualTypeOf<readonly CritiqueDto[]>();
    expectTypeOf<ProducerOutputOf<StoryReviewerAgent>>().toEqualTypeOf<
      ApprovalDto | DraftChangesDto
    >();
  });
});

describe("#269 AC1 / AC2: closed sets are enums, reasoning has one form", () => {
  const base = {
    name: "enum-agent",
    description: "Uses the enums",
    prompt: inline("Do it."),
    model: "moonshotai/kimi-k2.6",
  } as const;

  it("reasoning forms", () => {
    const forms: readonly AgentOptions[] = [
      { ...base, reasoning: Reasoning.off() },
      { ...base, reasoning: Reasoning.on({ effort: ReasoningEffort.High }) },
      { ...base, reasoning: Reasoning.modelDecides() },
    ];
    expectTypeOf(forms).toEqualTypeOf<readonly AgentOptions[]>();
  });

  it("thinking does not exist", () => {
    // @ts-expect-error — `thinking` is removed: reasoning: Reasoning.on({ effort })
    const options: AgentOptions = { ...base, thinking: "low" };
    expectTypeOf(options).toEqualTypeOf<AgentOptions>();
  });

  it("rag is a list of classes: { use, mode } does not compile", () => {
    const classes: AgentOptions = { ...base, rag: [DraftAgent] };
    // @ts-expect-error — `{ use, mode }` is removed: a @Tool that injects the @Rag searches, `rag` is context
    const wrapped: AgentOptions = { ...base, rag: [{ use: DraftAgent, mode: "context" }] };
    expectTypeOf([classes, wrapped]).toEqualTypeOf<AgentOptions[]>();
  });
});

describe("AC16: a shared options const keeps its exact types", () => {
  it("satisfies Omit<AgentOptions, name | description>", () => {
    expectTypeOf(reviewerAgentOptions.output).toEqualTypeOf<typeof ReviewDto>();
    const withName = {
      prompt: inline("Review it."),
      model: "moonshotai/kimi-k2.6",
      // @ts-expect-error — name is set by each class, never in the shared const
      name: "reviewer-agent",
    } satisfies Omit<AgentOptions, "name" | "description">;
    expectTypeOf(withName.prompt).toEqualTypeOf<ReturnType<typeof inline>>();
  });
});

describe("#270 AC12 / AC23: handlers take InputOf<Self>", () => {
  it("handlers take InputOf<Self>", () => {
    expectTypeOf<InputOf<SendOfferAction>>().toEqualTypeOf<{
      draft: Produced<OfferDraftDto, typeof DraftAgent | typeof EditorAgent>;
    }>();
    expectTypeOf<ActionHandler<SendOfferAction>["execute"]>().returns.toEqualTypeOf<
      OfferSentDto | Promise<OfferSentDto>
    >();
    expectTypeOf<
      ActionHandler<NotifyRecruiterAction>["execute"]
    >().returns.toEqualTypeOf<void | Promise<void>>();
  });

  it("no handler without input", () => {
    // @ts-expect-error — a finish without input has no handler
    @WorkflowFinish({ name: "bad-workflow-finish", description: "Bad", output: OfferSentDto })
    class HandledPassThroughWorkflowFinish {
      finish(): OfferSentDto {
        return { delivered: true };
      }
    }
    expectTypeOf(HandledPassThroughWorkflowFinish).toBeConstructibleWith();
  });

  it("a model router has no route()", () => {
    // @ts-expect-error — a model router's routes are chosen by its model
    @Router({
      name: "coded-router",
      description: "Bad",
      decidedBy: DecidedBy.Model,
      input: { draft: OfferDraftDto },
      routes: [{ target: DraftAgent, prompt: "Draft it" }],
    })
    class CodedRouter {
      route(): string {
        return "draft-agent";
      }
    }
    expectTypeOf(CodedRouter).toBeConstructibleWith();
  });

  it("an action implements execute", () => {
    // @ts-expect-error — an action's class implements ActionHandler: execute(input)
    @Action({ name: "empty-action", description: "Bad" })
    class EmptyAction {}
    expectTypeOf(EmptyAction).toBeConstructibleWith();
  });
});

describe("#270 AC2: variant / isVariant", () => {
  it("variant names a class; isVariant narrows a Produced value", () => {
    const item = {} as Produced<ChangesRequestedDto | DraftApprovedDto, typeof ReviewerAgent>;
    if (isVariant(item, ChangesRequestedDto)) {
      expectTypeOf(item.value).toEqualTypeOf<ChangesRequestedDto>();
    } else {
      expectTypeOf(item.value).toEqualTypeOf<DraftApprovedDto>();
    }
    // @ts-expect-error — the value must fit the class it names
    variant(ChangesRequestedDto, { delivered: true });
    expectTypeOf(variant(UnrelatedDto, { anything: "x" }).anything).toEqualTypeOf<string>();
  });
});

describe("#280 AC6, AC9: the execution context through the constructor, no ctx anywhere", () => {
  it("deps checked against the constructor: [ExecutionContext] takes an ExecutionContext", () => {
    @Action({ name: "audit-action", description: "Audits", deps: [ExecutionContext] })
    class AuditAction {
      constructor(readonly executionContext: ExecutionContext) {}

      execute(): Promise<void> {
        return Promise.resolve();
      }
    }
    // @ts-expect-error — the constructor takes a string where deps give an ExecutionContext
    @Action({ name: "wrong-audit-action", description: "Audits", deps: [ExecutionContext] })
    class WrongAuditAction {
      constructor(readonly executionId: string) {}

      execute(): Promise<void> {
        return Promise.resolve();
      }
    }
    expectTypeOf(AuditAction).toBeConstructibleWith(testExecutionContext());
    expectTypeOf(WrongAuditAction).toBeConstructibleWith("x");
  });

  it("no ctx anywhere: a tool's execute and a judge's judge take only their input", () => {
    expectTypeOf<Parameters<ToolHandler<NoteQueryDto, NoteQueryDto>["execute"]>>().toEqualTypeOf<
      [NoteQueryDto]
    >();
    expectTypeOf<Parameters<JudgeHandler<NoteQueryDto>["judge"]>>().toEqualTypeOf<
      [JudgeInput<NoteQueryDto>]
    >();
    const twoParameters: ToolHandler<NoteQueryDto, NoteQueryDto> = {
      // @ts-expect-error — a tool's run has no second parameter
      run: (input: NoteQueryDto, _ctx: string) => Promise.resolve(input),
    };
    expectTypeOf(twoParameters).not.toBeAny();
  });

  it("polymorphic this: a project subclass gets its own type back from the tree", () => {
    abstract class ClinicExecutionContext extends ExecutionContext {
      abstract readonly unitId: string;
    }
    const clinic = {} as ClinicExecutionContext;

    expectTypeOf(clinic.parent).toEqualTypeOf<ClinicExecutionContext | undefined>();
    expectTypeOf(clinic.root).toEqualTypeOf<ClinicExecutionContext>();
    expectTypeOf(clinic.executionOf(OfferWorkflow)).toEqualTypeOf<
      ClinicExecutionContext | undefined
    >();
    expectTypeOf(clinic.root.unitId).toEqualTypeOf<string>();
  });

  it("read-only: the fields cannot be assigned", () => {
    const context = testExecutionContext();
    // @ts-expect-error — executionId is read-only
    context.executionId = "forged";
    // @ts-expect-error — so is the step
    context.step.idempotencyKey = "forged";
    expectTypeOf(context.step).toEqualTypeOf<StepDescriptor>();
  });
});

describe("#280 AC1, AC2: code routers — options by decidedBy, route(input) typed by the flow", () => {
  it("router input types only; route(input) typed by InputOf", () => {
    expectTypeOf<InputOf<CreditLimitRouter>>().toEqualTypeOf<{
      order: Produced<CreditOrderDto, typeof OrderIntakeAgent>;
    }>();
    expectTypeOf<Parameters<RouterHandler<CreditLimitRouter>["route"]>>().toEqualTypeOf<
      [InputOf<CreditLimitRouter>]
    >();
  });

  it("Route<R> is the union of its targets: a target outside routes does not compile", () => {
    expectTypeOf<Route<CreditLimitRouter>>().toEqualTypeOf<
      typeof ApprovalAgent | typeof ChargeCardAction
    >();
    const charge: Route<CreditLimitRouter> = ChargeCardAction;
    // @ts-expect-error — the finish is not one of the router's routes
    const finish: Route<CreditLimitRouter> = OrderHeldWorkflowFinish;
    expectTypeOf(charge).not.toBeAny();
    expectTypeOf(finish).not.toBeAny();
  });

  it("Route<R> after .chooseOne(…) is every target: spawn policies apply to launches only", () => {
    // TopicsRouter's spawn: SpawnPolicy.Always fails assembly with .chooseOne(…); before a launch
    // (#273) Route<R> leaves the Always target out (tests/flow/types/generate.test.ts)
    expectTypeOf<Route<TopicsRouter>>().toEqualTypeOf<
      typeof DeliveryTopicAgent | typeof OrderTopicAgent | typeof RefundTopicAgent
    >();
  });

  it("a list answer may be empty: chooseMany picks none (#1279)", () => {
    type OnDemand = typeof DeliveryTopicAgent | typeof RefundTopicAgent;
    // what `routerAnswerText(…, RouteForm.List)` writes
    type Answer = readonly OnDemand[];
    const none: Answer = [];
    const some: Answer = [RefundTopicAgent];
    expectTypeOf(none).not.toBeAny();
    expectTypeOf(some).not.toBeAny();
  });

  it("the decorator checks route() against the generated types of its class (#1279)", () => {
    // a class carrying the brand of a generated router, whose route() answers what it must not
    class WrongAnswer {
      readonly [agbossComponent]?: {
        readonly name: "credit-limit-router";
        readonly kind: NodeKind.Router;
      };
      route(): string {
        return "draft";
      }
    }
    expectTypeOf<RouteChecked<typeof CreditLimitRouter>>().toEqualTypeOf<unknown>();
    expectTypeOf<RouteChecked<typeof WrongAnswer>>().toHaveProperty("__error");
  });

  it("a code router has route() and deps checked against its constructor", () => {
    // @ts-expect-error — a code router's class implements RouterHandler: route(input)
    @Router({
      name: "routeless-router",
      description: "Bad",
      decidedBy: DecidedBy.Code,
      input: { draft: OfferDraftDto },
      routes: [{ target: DraftAgent }],
    })
    class RoutelessRouter {}
    // @ts-expect-error — deps give an ExecutionContext, the constructor takes a string
    @Router({
      name: "wrong-deps-router",
      description: "Bad",
      decidedBy: DecidedBy.Code,
      input: { draft: OfferDraftDto },
      routes: [{ target: DraftAgent }],
      deps: [ExecutionContext],
    })
    class WrongDepsRouter {
      constructor(readonly executionId: string) {}

      route(): typeof DraftAgent {
        return DraftAgent;
      }
    }
    expectTypeOf(RoutelessRouter).toBeConstructibleWith();
    expectTypeOf(WrongDepsRouter).toBeConstructibleWith("x");
  });

  it("the other kind's options do not compile: model / prompt on Code, a route prompt", () => {
    // @ts-expect-error — no overload fits, so the class is checked as a model router's
    @Router({
      name: "prompted-code-router",
      description: "Bad",
      decidedBy: DecidedBy.Code,
      input: { draft: OfferDraftDto },
      // @ts-expect-error — a code router has no model
      model: "typesafe/jev-1.13",
      routes: [{ target: DraftAgent }],
    })
    class ModelledCodeRouter {
      route(): typeof DraftAgent {
        return DraftAgent;
      }
    }
    // @ts-expect-error — a code router's route has no prompt
    @Router({
      name: "route-prompt-code-router",
      description: "Bad",
      decidedBy: DecidedBy.Code,
      input: { draft: OfferDraftDto },
      routes: [{ target: DraftAgent, prompt: "Draft it" }],
    })
    class RoutePromptCodeRouter {
      route(): typeof DraftAgent {
        return DraftAgent;
      }
    }
    expectTypeOf(ModelledCodeRouter).toBeConstructibleWith();
    expectTypeOf(RoutePromptCodeRouter).toBeConstructibleWith();
  });

  it("spawn on both kinds: a model OnDemand route needs a prompt, an Always route has none", () => {
    const always: ModelRouterOptions["routes"][number] = {
      target: DraftAgent,
      spawn: SpawnPolicy.Always,
      failure: FailurePolicy.Skip,
    };
    // @ts-expect-error — an OnDemand route of a model router needs its prompt
    const unprompted: ModelRouterOptions["routes"][number] = { target: DraftAgent };
    // @ts-expect-error — an Always route is never shown to the model: no prompt
    const prompted: ModelRouterOptions["routes"][number] = {
      target: DraftAgent,
      spawn: SpawnPolicy.Always,
      prompt: "Draft it",
    };
    const code: CodeRouterOptions["routes"][number] = {
      target: DraftAgent,
      spawn: SpawnPolicy.Always,
      failure: FailurePolicy.FailFast,
    };
    expectTypeOf(always).not.toBeAny();
    expectTypeOf(unprompted).not.toBeAny();
    expectTypeOf(prompted).not.toBeAny();
    expectTypeOf(code).not.toBeAny();
  });
});

describe("#273: parallel launches and their joins", () => {
  const planned = () => onAgent(PlannerAgent);
  const screened = () => onAgent(ScreeningAgent);
  const charged = () => onAction(ChargePaymentAction);

  it("AC4: launch without join — a launch is followed by .join() only", () => {
    const launched = planned().toParallelAgents(PlanResearcherAgent, CriticAgent, CriticAgent);
    // @ts-expect-error — a launch is followed by .join(), never by a transition
    launched.toAgent(ArticleWriterAgent);
    // @ts-expect-error — `.onError` is the join's handler: it is not offered between a launch and its join (#1281)
    launched.onError(StepFailedError, toFinish(ScreeningFailedWorkflowFinish));
    const flow: readonly FlowPath[] = [
      // @ts-expect-error — a path that stops at a launch is not a path
      onStart(OfferWorkflowStart).toAgent(DraftAgent).toParallelAgents(ReviewerAgent),
    ];
    expectTypeOf(launched).toHaveProperty("join");
    expectTypeOf(flow).not.toBeAny();
  });

  it("AC4: wrong target kind — agents for toParallelAgents, actions for toParallelActions", () => {
    // @ts-expect-error — send-receipt-action is not an agent
    charged().toParallelAgents(SendReceiptAction);
    // @ts-expect-error — critic-agent is not an action
    planned().toParallelActions(CriticAgent);
    const routed = onStart(OfferWorkflowStart).toRouter(MainRouter);
    // @ts-expect-error — a router launches agents only
    routed.toParallelActions(SendOfferAction);
    expectTypeOf(charged()).toHaveProperty("toParallelActions");
  });

  it("AC5: join returns checked against the branches' output — listOf for copies", () => {
    const joined = planned()
      .toParallelAgents(PlanResearcherAgent, CriticAgent, CriticAgent, { maxConcurrency: 3 })
      .join();
    joined.toAgent(ArticleWriterAgent);
    // @ts-expect-error — the join's handler is `.onError`: `.onJoinError` is gone (#1281)
    joined.onJoinError(LimitExceededError, toFinish(ScreeningFailedWorkflowFinish));
    // @ts-expect-error — no launch right after a join's values
    joined.toParallelAgents(CriticAgent);
    expectTypeOf(joined).toHaveProperty("onError");
  });

  it("AC2: per-item needs an XDto field — one run per item, the join a list", () => {
    screened()
      .toParallelAgents(CompanyAuditAgent, { maxConcurrency: 3, maxItems: 50 })
      .join()
      .onError(LimitExceededError, toAction(NotifyOperatorAction))
      .toAgent(RankerAgent);
    const audited = screened().toParallelAgents(CompanyAuditAgent, { maxItems: 50 }).join();
    // @ts-expect-error — item-blind-agent reads no CompanyDto: [launch.item-not-read]
    screened().toParallelAgents(ItemBlindAgent, { maxItems: 5 });
    expectTypeOf<InputOf<ItemBlindAgent>>().toHaveProperty("__error");
  });

  it("AC11: output-less actions join — .join() goes on with .to…(…) at once", () => {
    const joined = charged()
      .toParallelActions(SendReceiptAction, UpdateCrmAction, ReserveGoodsAction, {
        maxConcurrency: 3,
      })
      .join();
    joined.toFinish(PaymentWorkflowFinish);
    expectTypeOf(joined).toHaveProperty("toFinish");
  });

  it("AC6 / AC8: a router launch — optional for OnDemand and Skip, a code router's list", () => {
    const joined = onStart(OfferWorkflowStart)
      .toRouter(HelpDeskRouter)
      .toParallelAgents(OrderLookupAgent, RefundPolicyAgent, LoyaltyOfferAgent)
      .join();
    joined.toAgent(AnswerAgent);
    expectTypeOf<RouterAnswerOf<OffersRouter>>().toEqualTypeOf<
      readonly (typeof LoyaltyOfferAgent)[]
    >();
    expectTypeOf<InputOf<AnswerAgent>["order"]>().toEqualTypeOf<
      Produced<OrderStatusDto, typeof OrderLookupAgent>
    >();
    expectTypeOf<ProducerOutputOf<AnswerAgent>>().toEqualTypeOf<HelpDeskReplyDto>();
  });
});

describe("#263: child workflows", () => {
  const picked = () => onAgent(CompanyPickerAgent);
  const found = () => onAgent(CompanyFinderAgent);
  const graded = () =>
    caseOf(CompanyGradeDto).toAgent(JobOfferAgent).toFinish(JobOfferWorkflowFinish);
  const rejected = () => caseOf(CompanyRejectedDto).toFinish(NoOfferRejectedWorkflowFinish);
  const failed = () => caseOf(CompanyReviewFailedDto).toFinish(NoOfferFailedWorkflowFinish);
  const REVIEWED = oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto);

  it("AC3: child outputs — one case per finish output class, written as", () => {
    const reviewed = picked().toWorkflow(CompanyReviewWorkflow);
    reviewed.switch(graded(), rejected(), failed());
    // @ts-expect-error — the switch is not exhaustive: no caseOf(CompanyReviewFailedDto)
    reviewed.switch(graded(), rejected());
    const unknown = caseOf(JobOfferDto).toFinish(JobOfferWorkflowFinish);
    // @ts-expect-error — no finish of the child gives JobOfferDto
    reviewed.switch(graded(), rejected(), failed(), unknown);
    expectTypeOf<ProducerOutputOf<CompanyReviewWorkflow>>().toEqualTypeOf<
      CompanyGradeDto | CompanyRejectedDto | CompanyReviewFailedDto
    >();
  });

  it("AC12: onError placement — right after .toWorkflow(W) and after the join, not between a launch and its join", () => {
    picked()
      .toWorkflow(CompanyReviewWorkflow)
      .onError(StepFailedError, toFinish(ReviewErrorWorkflowFinish))
      .switch(graded(), rejected(), failed());
    const single = picked().toWorkflow(CompanyReviewWorkflow);
    single.onError(StepFailedError, toFinish(ReviewErrorWorkflowFinish));
    const joined = found().toParallelWorkflows(CompanyReviewWorkflow, { maxItems: 5 }).join();
    // @ts-expect-error — the join's handler is `.onError`: `.onJoinError` is gone (#1281)
    joined.onJoinError(StepFailedError, toFinish(ReviewErrorWorkflowFinish));
    joined.onError(StepFailedError, toFinish(ReviewErrorWorkflowFinish)).toAgent(ReviewRankerAgent);
    expectTypeOf(joined).toHaveProperty("onError");
  });

  it("AC5 / AC17: per item only, maxItems required; the join gives the list of the child's classes", () => {
    const joined = found()
      .toParallelWorkflows(CompanyReviewWorkflow, { maxConcurrency: 3, maxItems: 50 })
      .join();
    joined.toAgent(ReviewRankerAgent);
    // @ts-expect-error — one child per item: right after
    picked().toParallelWorkflows(CompanyReviewWorkflow, { maxItems: 5 });
    // @ts-expect-error — maxItems is required
    found().toParallelWorkflows(CompanyReviewWorkflow, { maxConcurrency: 3 });
    // @ts-expect-error — company-picker-agent is not a workflow
    found().toParallelWorkflows(CompanyPickerAgent, { maxItems: 5 });
    expectTypeOf(joined).toHaveProperty("toAgent");
  });

  it("own path onWorkflow(W), the kind of every child checked, the start choice a compile error", () => {
    onWorkflow(CompanyReviewWorkflow)
      .onError(StepFailedError, toFinish(ReviewErrorWorkflowFinish))
      .switch(graded(), rejected(), failed());
    // @ts-expect-error — company-picker-agent is not a workflow
    onWorkflow(CompanyPickerAgent);
    // @ts-expect-error — job-offer-agent is not a workflow
    picked().toWorkflow(JobOfferAgent);
    // @ts-expect-error — company-review-workflow is not an agent
    picked().toAgent(CompanyReviewWorkflow);
    // @ts-expect-error — two starts of twin-grade-workflow take CompanyDto: [graph.ambiguous-start]
    picked().toWorkflow(TwinGradeWorkflow);
    expectTypeOf<InputOf<TwinGradeWorkflow>>().toHaveProperty("__error");
  });
});
