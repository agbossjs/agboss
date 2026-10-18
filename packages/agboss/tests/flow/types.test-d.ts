import { describe, expectTypeOf, it } from "vitest";
import type { FlowPath } from "../../src/flow/ast.js";
import {
  agent,
  action,
  caseOf,
  route,
  router,
  start,
  toAction,
  toAgent,
  toFinish,
  toRouter,
} from "../../src/flow/builder.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Agent, RagMode, type AgentOptions } from "../../src/flow/decorators/agent.js";
import {
  DecidedBy,
  FailurePolicy,
  Router,
  SpawnPolicy,
  type CodeRouterOptions,
  type ModelRouterOptions,
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
  type ValueOf,
} from "../../src/flow/dto-wrappers.js";
import type {
  InputOf,
  MissingGeneratedTypes,
  OutputOf,
  ProducerOutputOf,
  Route,
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
  MainRouter,
  ProfilerAgent,
  ScoutAgent,
} from "./fixtures/chat.fixture.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  OpeningsDto,
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

/**
 * Compile-time checks of the v2 flow (#272 PR 1, S3). Checked by `tsc` (the gate's typecheck), not
 * run by Vitest. Each `@ts-expect-error` is a negative test: tsc fails this file if the line
 * compiles. The types come from `.agboss/types.d.ts`, generated for the fixtures by `check:types`.
 */

/** A component the generated types do not know yet (no brand): every check names the fix. */
@Agent({
  name: "fresh-agent",
  description: "Added after the last agboss check",
  prompt: "Do it.",
  model: "moonshotai/kimi-k2.6",
})
class FreshAgent {}

describe("AC1: a path starts with its source's kind", () => {
  it("a source of the wrong kind does not compile", () => {
    start(OfferWorkflowStart);
    agent(ReviewerAgent);
    router(MainRouter);
    action(SendOfferAction);
    // @ts-expect-error — MainRouter is not an agent
    agent(MainRouter);
    // @ts-expect-error — DraftAgent is not a workflow start
    start(DraftAgent);
    // @ts-expect-error — DraftAgent is not a router
    router(DraftAgent);
    // @ts-expect-error — DraftAgent is not an action
    action(DraftAgent);
    expectTypeOf(start(OfferWorkflowStart)).toExtend<FlowPath>();
  });
});

describe("AC2: transitions name the target's kind", () => {
  it("a target of the wrong kind does not compile", () => {
    const shortlist = start(OfferWorkflowStart).returns(ShortlistDto);
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
    start(OfferWorkflowStart).returns(ShortlistDto);
    // @ts-expect-error — the start's input is ShortlistDto
    start(OfferWorkflowStart).returns(OfferDraftDto);
    const drafted = start(OfferWorkflowStart).returns(ShortlistDto).toAgent(DraftAgent);
    drafted.returns(OfferDraftDto);
    // @ts-expect-error — draft-agent gives OfferDraftDto, not a list of it
    drafted.returns(listOf(OfferDraftDto));
    // @ts-expect-error — draft-agent gives OfferDraftDto
    drafted.returns(ShortlistDto);
    expectTypeOf<ProducerOutputOf<DraftAgent>>().toEqualTypeOf<OfferDraftDto>();
  });

  it("a next node that cannot take what the path carries does not compile", () => {
    const drafted = start(OfferWorkflowStart).returns(ShortlistDto).toAgent(DraftAgent);
    // @ts-expect-error — broken-agent's generated input reports [input.missing-on-path]
    drafted.returns(OfferDraftDto).toAgent(BrokenAgent);
    expectTypeOf<InputOf<BrokenAgent>>().toHaveProperty("__error");
  });
});

describe("S3: before generation every check names the fix", () => {
  it("an unbranded class resolves to the diagnostic type", () => {
    // @ts-expect-error — Missing generated types — run `agboss check`
    agent(FreshAgent);
    // @ts-expect-error — Missing generated types — run `agboss check`
    start(OfferWorkflowStart).returns(ShortlistDto).toAgent(FreshAgent);
    expectTypeOf<InputOf<FreshAgent>>().toEqualTypeOf<MissingGeneratedTypes>();
    expectTypeOf<OutputOf<FreshAgent>>().toEqualTypeOf<MissingGeneratedTypes>();
  });
});

describe("AC15: .returns follows every step with an output and no step without one", () => {
  it("returns required after output, impossible after void action", () => {
    const drafted = start(OfferWorkflowStart).returns(ShortlistDto).toAgent(DraftAgent);
    // @ts-expect-error — draft-agent has an output: .returns(OfferDraftDto) comes first
    drafted.toAgent(ReviewerAgent);
    // @ts-expect-error — a start returns its input first
    start(OfferWorkflowStart).toAgent(DraftAgent);
    const notified = toAction(NotifyRecruiterAction);
    notified.toFinish(OfferSentWorkflowFinish);
    // @ts-expect-error — notify-recruiter-action has no output: nothing to return
    notified.returns(OfferSentDto);
    // @ts-expect-error — one .returns per step
    drafted.returns(OfferDraftDto).returns(OfferDraftDto);
    expectTypeOf(notified).toHaveProperty("toFinish");
  });
});

describe("AC5: .returns(oneOf(…)).switch(caseOf(…)) after a oneOf output (#299 S54 c)", () => {
  it("caseOf outside oneOf does not compile, nor a missing case", () => {
    const reviewed = agent(ReviewerAgent).returns(oneOf(ChangesRequestedDto, DraftApprovedDto));
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
    // @ts-expect-error — a oneOf output is returned whole, oneOf(…), never one of its classes
    agent(ReviewerAgent).returns(ChangesRequestedDto);
    // @ts-expect-error — the oneOf is the step's own: the same classes
    agent(ReviewerAgent).returns(oneOf(ChangesRequestedDto, OfferSentDto));
    // @ts-expect-error — a single output is returned, not switched
    agent(DraftAgent).returns(OfferDraftDto).switch(caseOf(OfferDraftDto).toAgent(ReviewerAgent));
    expectTypeOf<ProducerOutputOf<ProfilerAgent>>().toEqualTypeOf<ProfileDto | ResumeMissingDto>();
  });
});

describe("AC6: a router continues with chooseOne(route(…)…)", () => {
  it("chooseOne takes routes only", () => {
    router(MainRouter).chooseOne(
      route(ScoutAgent).returns(OpeningsDto).toFinish(ChatWorkflowFinish),
    );
    // @ts-expect-error — chooseOne takes route(…) paths, not caseOf(…)
    router(MainRouter).chooseOne(caseOf(ProfileDto).toRouter(MainRouter));
    // @ts-expect-error — a router gives no value to return
    router(MainRouter).returns(ProfileDto);
    expectTypeOf(router(MainRouter)).toHaveProperty("chooseOne");
  });
});

describe("AC7: .onError stands right after the step that throws", () => {
  it("onError takes a toAction side path and does not follow .returns", () => {
    const edited = agent(EditorAgent).onError(
      VisitsLimitExceededError,
      toAction(NotifyRecruiterAction),
    );
    const returned = edited.returns(OfferDraftDto);
    const sidePath = toAction(NotifyRecruiterAction);
    // @ts-expect-error — .onError comes before the step's .returns, never after it
    returned.onError(VisitsLimitExceededError, sidePath);
    // @ts-expect-error — the side path is toAction(…)…, not a route
    agent(EditorAgent).onError(VisitsLimitExceededError, route(EditorAgent));
    expectTypeOf(edited).toHaveProperty("returns");
  });
});

describe("AC7: a side path starts with any transition, kinds checked", () => {
  it("toAction, toAgent, toRouter and toFinish begin a side path", () => {
    const edited = agent(EditorAgent)
      .onError(VisitsLimitExceededError, toFinish(OfferSentWorkflowFinish))
      .onError(Error, toAgent(DraftAgent).returns(OfferDraftDto).toAgent(ReviewerAgent))
      .onError(
        RangeError,
        toRouter(MainRouter).chooseOne(
          route(ScoutAgent).returns(OpeningsDto).toFinish(ChatWorkflowFinish),
        ),
      );
    // @ts-expect-error — MainRouter is not an agent
    toAgent(MainRouter);
    // @ts-expect-error — DraftAgent is not a router
    toRouter(DraftAgent);
    // @ts-expect-error — DraftAgent is not a workflow finish
    toFinish(DraftAgent);
    // @ts-expect-error — draft-agent has an output: .returns(OfferDraftDto) comes first
    toAgent(DraftAgent).toAgent(ReviewerAgent);
    const finished = toFinish(OfferSentWorkflowFinish);
    // @ts-expect-error — nothing follows a finish
    finished.toAgent(DraftAgent);
    expectTypeOf(edited).toHaveProperty("returns");
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
  it("historyOf names one DTO class and a limit; only an input field takes it", () => {
    expectTypeOf(historyOf(DraftDto, { limit: 2 }).dto).toEqualTypeOf<typeof DraftDto>();
    expectTypeOf<ValueOf<ReturnType<typeof historyOf<typeof DraftDto>>>>().toEqualTypeOf<
      HistoryOf<DraftDto>
    >();
    // @ts-expect-error — historyOf names one class, not a list
    historyOf(listOf(DraftDto));
    // @ts-expect-error — a history always has its current value: never optional
    optional(historyOf(DraftDto));
    // @ts-expect-error — a list element is a class or a oneOf
    listOf(historyOf(DraftDto));
    // @ts-expect-error — the limit is a number of versions
    historyOf(DraftDto, { limit: "2" });
    // @ts-expect-error — a step returns values, never a history of them
    agent(DraftAgent).returns(historyOf(OfferDraftDto));
  });

  it("a component declares a plain output; historyOf is no output and no start input", () => {
    @Agent({
      name: "typed-critic-agent",
      description: "Critiques",
      prompt: "Critique it.",
      model: "moonshotai/kimi-k2.6",
      input: { drafts: historyOf(DraftDto, { limit: 3 }) },
      output: listOf(CritiqueDto),
    })
    class TypedCriticAgent {}
    expectTypeOf(TypedCriticAgent).toBeConstructibleWith();
    @Agent({
      name: "history-output-agent",
      description: "Bad",
      prompt: "Answer.",
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
    prompt: "Do it.",
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

  it("rag mode string does not compile", () => {
    const tool: AgentOptions = { ...base, rag: [{ use: DraftAgent, mode: RagMode.Tool }] };
    // @ts-expect-error — the mode is RagMode.Context, not a string
    const context: AgentOptions = { ...base, rag: [{ use: DraftAgent, mode: "context" }] };
    expectTypeOf([tool, context]).toEqualTypeOf<AgentOptions[]>();
  });
});

describe("AC16: a shared options const keeps its exact types", () => {
  it("satisfies Omit<AgentOptions, name | description>", () => {
    expectTypeOf(reviewerAgentOptions.output).toEqualTypeOf<typeof ReviewDto>();
    const withName = {
      prompt: "Review it.",
      model: "moonshotai/kimi-k2.6",
      // @ts-expect-error — name is set by each class, never in the shared const
      name: "reviewer-agent",
    } satisfies Omit<AgentOptions, "name" | "description">;
    expectTypeOf(withName.prompt).toEqualTypeOf<string>();
  });
});

describe("#270 AC12 / AC23: handlers take InputOf<Self>", () => {
  it("handlers take InputOf<Self>", () => {
    expectTypeOf<InputOf<SendOfferAction>>().toEqualTypeOf<{
      draft: Produced<OfferDraftDto, typeof DraftAgent | typeof EditorAgent>;
    }>();
    expectTypeOf<ActionHandler<SendOfferAction>["execute"]>().returns.toEqualTypeOf<
      Promise<OfferSentDto>
    >();
    expectTypeOf<ActionHandler<NotifyRecruiterAction>["execute"]>().returns.toEqualTypeOf<
      Promise<void>
    >();
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

  it("no ctx anywhere: a tool's run and a judge's judge take only their input", () => {
    expectTypeOf<Parameters<ToolHandler<NoteQueryDto, NoteQueryDto>["run"]>>().toEqualTypeOf<
      [NoteQueryDto]
    >();
    expectTypeOf<Parameters<JudgeHandler["judge"]>>().toEqualTypeOf<[JudgeInput]>();
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

  it("return [] only with Always: the list forms route() returns before a launch (#273)", () => {
    type OnDemand = typeof DeliveryTopicAgent | typeof RefundTopicAgent;
    // what `routerAnswerText(…, RouteForm.List, …)` writes, without and with an Always route
    type WithoutAlways = readonly [OnDemand, ...OnDemand[]];
    type WithAlways = readonly OnDemand[];
    // @ts-expect-error — without an Always route the list is never empty
    const none: WithoutAlways = [];
    const some: WithoutAlways = [RefundTopicAgent];
    const empty: WithAlways = [];
    expectTypeOf(none).not.toBeAny();
    expectTypeOf(some).not.toBeAny();
    expectTypeOf(empty).not.toBeAny();
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
