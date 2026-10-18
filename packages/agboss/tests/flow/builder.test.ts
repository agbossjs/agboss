import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type Step } from "../../src/flow/ast.js";
import * as builder from "../../src/flow/builder.js";
import {
  FlowSyntaxError,
  caseOf,
  route,
  start,
  toAction,
  toAgent,
  toFinish,
  toRouter,
} from "../../src/flow/builder.js";
import type { DtoClass } from "../../src/dto/types.js";
import { listOf, oneOf, optional, type ReturnedShape } from "../../src/flow/dto-wrappers.js";
import {
  articlePaths,
  ArticleDraftAgent,
  ArticleWorkflowFinish,
  ArticleWorkflowStart,
  DraftReviewerAgent,
  FinalReviewerAgent,
  WriterAgent,
} from "./fixtures/article.fixture.js";
import {
  AskResumeWorkflowFinish,
  chatPaths,
  ChatWorkflowFinish,
  IntakeWorkflowStart,
  MainRouter,
  NoReplyWorkflowFinish,
  ProfilerAgent,
  ScoutAgent,
} from "./fixtures/chat.fixture.js";
import {
  ArticleDto,
  ArticleRequestDto,
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  OpeningsDto,
  OrderRequestDto,
  OrderShippedDto,
  ProfileDto,
  ResumeMissingDto,
  ReviewDto,
  ShortlistDto,
  StockReservationDto,
  WorkflowStartTextDto,
} from "./fixtures/dtos.js";
import {
  DraftAgent,
  EditorAgent,
  NotifyRecruiterAction,
  offerPaths,
  OfferFailedWorkflowFinish,
  OfferSentWorkflowFinish,
  OfferWorkflowStart,
  ReviewerAgent,
  SendOfferAction,
  VisitsLimitExceededError,
} from "./fixtures/offer.fixture.js";
import {
  CarrierError,
  NotifyFinanceTeamAction,
  orderPaths,
  OrderFailedWorkflowFinish,
  OrderWorkflowFinish,
  OrderWorkflowStart,
  PaymentProviderError,
  RefundCardAction,
  ReleaseStockAction,
  ReserveStockAction,
  ShipOrderAction,
} from "./fixtures/order.fixture.js";

/** The AST each construct of the path grammar builds (#272 → The AST). */

/** Calls a builder method past its types, as untyped code could. */
function callUntyped(target: object, method: string, args: readonly unknown[]): unknown {
  const callee: unknown = Reflect.get(target, method);
  if (typeof callee !== "function") throw new TypeError(`${method} is not a method`);
  const result: unknown = Reflect.apply(callee, target, args);
  return result;
}

const returns = (shape: ReturnedShape, about?: readonly DtoClass[]): Step =>
  about === undefined
    ? { kind: StepKind.Returns, value: { shape } }
    : { kind: StepKind.Returns, value: { shape, about } };

const to = (target: abstract new () => unknown, targetKind: NodeKind): Step => ({
  kind: StepKind.To,
  target,
  targetKind,
});

describe("AC1: a path starts with its source's kind", () => {
  it("records start, agent, router and action sources", () => {
    expect(start(OfferWorkflowStart).source).toEqual({
      kind: NodeKind.Start,
      node: OfferWorkflowStart,
    });
    expect(builder.agent(ReviewerAgent).source).toEqual({
      kind: NodeKind.Agent,
      node: ReviewerAgent,
    });
    expect(builder.router(MainRouter).source).toEqual({
      kind: NodeKind.Router,
      node: MainRouter,
    });
    expect(builder.action(SendOfferAction).source).toEqual({
      kind: NodeKind.Action,
      node: SendOfferAction,
    });
  });
});

describe("AC2: transitions name the target's kind", () => {
  it("records each step of a straight path in order (#272 example 2b)", () => {
    const [path] = articlePaths;

    expect(path.source).toEqual({ kind: NodeKind.Start, node: ArticleWorkflowStart });
    expect(path.steps).toEqual([
      returns(ArticleRequestDto),
      to(ArticleDraftAgent, NodeKind.Agent),
      returns(ArticleDto),
      to(DraftReviewerAgent, NodeKind.Agent),
      returns(ReviewDto),
      to(WriterAgent, NodeKind.Agent),
      returns(ArticleDto),
      to(FinalReviewerAgent, NodeKind.Agent),
      returns(ReviewDto),
      to(ArticleWorkflowFinish, NodeKind.Finish),
    ]);
  });

  it("records toRouter and toAction with their kinds", () => {
    expect(chatPaths[0].steps.at(-1)).toEqual(to(MainRouter, NodeKind.Router));
    expect(orderPaths[0].steps[1]).toEqual(to(ReserveStockAction, NodeKind.Action));
  });
});

describe("AC3 / AC5 / AC6: router own path, chooseOne and switch (#272 example 1)", () => {
  it("builds chooseOne routes with their sub-paths and a switch inside a route", () => {
    const [, mainRouterPath] = chatPaths;

    expect(mainRouterPath.source).toEqual({ kind: NodeKind.Router, node: MainRouter });
    expect(mainRouterPath.steps).toEqual([
      {
        kind: StepKind.ChooseOne,
        routes: [
          {
            target: ProfilerAgent,
            path: {
              steps: [
                returns(oneOf(ProfileDto, ResumeMissingDto)),
                {
                  kind: StepKind.Switch,
                  cases: [
                    { dto: ProfileDto, path: { steps: [to(MainRouter, NodeKind.Router)] } },
                    {
                      dto: ResumeMissingDto,
                      path: { steps: [to(AskResumeWorkflowFinish, NodeKind.Finish)] },
                    },
                  ],
                },
              ],
            },
          },
          {
            target: ScoutAgent,
            path: { steps: [returns(OpeningsDto), to(ChatWorkflowFinish, NodeKind.Finish)] },
          },
          { target: NoReplyWorkflowFinish, path: { steps: [] } },
        ],
      },
    ]);
    expect(chatPaths[0].steps[0]).toEqual(returns(WorkflowStartTextDto));
    expect(chatPaths[0].source.node).toBe(IntakeWorkflowStart);
  });
});

describe("AC7: onError side paths (#272 examples 2a and 3)", () => {
  it("puts the side path right after the step, before its returns", () => {
    const [, reviewerPath] = offerPaths;
    const [returned, switchStep] = reviewerPath.steps;

    expect(returned).toEqual(returns(oneOf(ChangesRequestedDto, DraftApprovedDto)));
    expect(switchStep).toEqual({
      kind: StepKind.Switch,
      cases: [
        {
          dto: ChangesRequestedDto,
          about: [OfferDraftDto],
          path: {
            steps: [
              to(EditorAgent, NodeKind.Agent),
              {
                kind: StepKind.OnError,
                error: VisitsLimitExceededError,
                path: {
                  steps: [
                    to(NotifyRecruiterAction, NodeKind.Action),
                    to(OfferFailedWorkflowFinish, NodeKind.Finish),
                  ],
                },
              },
              returns(OfferDraftDto),
              to(ReviewerAgent, NodeKind.Agent),
            ],
          },
        },
        {
          dto: DraftApprovedDto,
          path: {
            steps: [
              to(SendOfferAction, NodeKind.Action),
              returns(OfferSentDto),
              to(OfferSentWorkflowFinish, NodeKind.Finish),
            ],
          },
        },
      ],
    });
    expect(offerPaths[0].steps).toEqual([
      returns(ShortlistDto),
      to(DraftAgent, NodeKind.Agent),
      returns(OfferDraftDto),
      to(ReviewerAgent, NodeKind.Agent),
    ]);
  });

  it("nests an onError inside a side path for a failed rollback", () => {
    expect(orderPaths[0].steps).toEqual([
      returns(OrderRequestDto),
      to(ReserveStockAction, NodeKind.Action),
      returns(StockReservationDto),
      to(ShipOrderAction, NodeKind.Action),
      {
        kind: StepKind.OnError,
        error: CarrierError,
        path: {
          steps: [
            to(RefundCardAction, NodeKind.Action),
            {
              kind: StepKind.OnError,
              error: PaymentProviderError,
              path: {
                steps: [
                  to(NotifyFinanceTeamAction, NodeKind.Action),
                  to(OrderFailedWorkflowFinish, NodeKind.Finish),
                ],
              },
            },
            to(ReleaseStockAction, NodeKind.Action),
            to(OrderFailedWorkflowFinish, NodeKind.Finish),
          ],
        },
      },
      returns(OrderShippedDto),
      to(OrderWorkflowFinish, NodeKind.Finish),
    ]);
    expect(orderPaths[0].source.node).toBe(OrderWorkflowStart);
  });
});

describe("AC7: a side path may start with any transition", () => {
  it("toFinish ends the side path at a finish", () => {
    const shipped = builder
      .action(ShipOrderAction)
      .onError(CarrierError, toFinish(OrderFailedWorkflowFinish));

    expect(shipped.steps).toEqual([
      {
        kind: StepKind.OnError,
        error: CarrierError,
        path: { steps: [to(OrderFailedWorkflowFinish, NodeKind.Finish)] },
      },
    ]);
  });

  it("toAgent continues the side path through an agent", () => {
    const edited = builder
      .agent(EditorAgent)
      .onError(
        VisitsLimitExceededError,
        toAgent(DraftAgent).returns(OfferDraftDto).toAgent(ReviewerAgent),
      );

    expect(edited.steps[0]).toEqual({
      kind: StepKind.OnError,
      error: VisitsLimitExceededError,
      path: {
        steps: [
          to(DraftAgent, NodeKind.Agent),
          returns(OfferDraftDto),
          to(ReviewerAgent, NodeKind.Agent),
        ],
      },
    });
  });

  it("toRouter continues the side path with the router's chooseOne", () => {
    const escalated = builder
      .agent(EditorAgent)
      .onError(
        VisitsLimitExceededError,
        toRouter(MainRouter).chooseOne(
          route(ScoutAgent).returns(OpeningsDto).toFinish(ChatWorkflowFinish),
        ),
      );

    expect(escalated.steps[0]).toEqual({
      kind: StepKind.OnError,
      error: VisitsLimitExceededError,
      path: {
        steps: [
          to(MainRouter, NodeKind.Router),
          {
            kind: StepKind.ChooseOne,
            routes: [
              {
                target: ScoutAgent,
                path: { steps: [returns(OpeningsDto), to(ChatWorkflowFinish, NodeKind.Finish)] },
              },
            ],
          },
        ],
      },
    });
  });
});

describe("#299 S54: one value per .returns, { about } in the flow", () => {
  it("records { about } on returns — one class or a list of them — and on caseOf", () => {
    const critiqued = start(OfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftAgent)
      .returns(OfferDraftDto, { about: ShortlistDto });
    const both = callUntyped(builder.agent(DraftAgent), "returns", [
      OfferDraftDto,
      { about: [ShortlistDto, ReviewDto] },
    ]);
    const aboutCase = caseOf(ChangesRequestedDto, { about: OfferDraftDto }).toAgent(EditorAgent);

    expect(critiqued.steps.at(-1)).toEqual(returns(OfferDraftDto, [ShortlistDto]));
    expect(Reflect.get(both as object, "steps")).toEqual([
      returns(OfferDraftDto, [ShortlistDto, ReviewDto]),
    ]);
    expect(
      callUntyped(builder.agent(ReviewerAgent), "switch", [aboutCase, caseOf(DraftApprovedDto)]),
    ).toEqual(
      expect.objectContaining({
        steps: [
          {
            kind: StepKind.Switch,
            cases: [
              {
                dto: ChangesRequestedDto,
                about: [OfferDraftDto],
                path: { steps: [to(EditorAgent, NodeKind.Agent)] },
              },
              { dto: DraftApprovedDto, path: { steps: [] } },
            ],
          },
        ],
      }),
    );
  });

  it("several values are a chain of .returns, each one value with its wrappers", () => {
    const listed = start(OfferWorkflowStart);
    const values = [listOf(ShortlistDto), optional(OfferDraftDto)] as const;

    const path = callUntyped(callUntyped(listed, "returns", [values[0]]) as object, "returns", [
      values[1],
    ]);

    expect(Reflect.get(path as object, "steps")).toEqual([returns(values[0]), returns(values[1])]);
  });

  it.each([
    [
      "two values in one .returns",
      () => callUntyped(builder.agent(DraftAgent), "returns", [OfferDraftDto, ShortlistDto]),
    ],
    [
      "three arguments",
      () => callUntyped(builder.agent(DraftAgent), "returns", [OfferDraftDto, {}, ShortlistDto]),
    ],
    [
      "{ about } on a oneOf",
      () =>
        callUntyped(builder.agent(ReviewerAgent), "returns", [
          oneOf(ChangesRequestedDto, DraftApprovedDto),
          { about: OfferDraftDto },
        ]),
    ],
    [
      "an empty { about }",
      () => callUntyped(builder.agent(DraftAgent), "returns", [OfferDraftDto, { about: [] }]),
    ],
    [
      "{ about } that is not a class",
      () => callUntyped(builder.agent(DraftAgent), "returns", [OfferDraftDto, { about: "X" }]),
    ],
  ])("refuses %s from untyped code", (_name, misuse) => {
    expect(misuse).toThrow(FlowSyntaxError);
  });
});

describe("paths are immutable", () => {
  it("a builder continued twice gives two independent paths, frozen", () => {
    const shortlisted = start(OfferWorkflowStart).returns(ShortlistDto);

    const drafted = shortlisted.toAgent(DraftAgent);
    const failed = shortlisted.toFinish(OfferFailedWorkflowFinish);

    expect(shortlisted.steps).toHaveLength(1);
    expect(drafted.steps.at(-1)).toEqual(to(DraftAgent, NodeKind.Agent));
    expect(failed.steps.at(-1)).toEqual(to(OfferFailedWorkflowFinish, NodeKind.Finish));
    expect(Object.isFrozen(drafted.steps)).toBe(true);
    expect(Reflect.get(route(EditorAgent), "source")).toBeUndefined();
  });
});

describe("misuse from untyped code fails with FlowSyntaxError", () => {
  const reviewer = builder.agent(ReviewerAgent);
  const router = builder.router(MainRouter);
  const edited = builder.agent(EditorAgent);

  it.each([
    ["switch takes caseOf paths", () => callUntyped(reviewer, "switch", [route(DraftAgent)])],
    ["chooseOne takes route paths", () => callUntyped(router, "chooseOne", [caseOf(ProfileDto)])],
    [
      "onError takes a toAction side path",
      () => callUntyped(edited, "onError", [CarrierError, route(DraftAgent)]),
    ],
    ["returns takes DTO shapes", () => callUntyped(edited, "returns", ["OfferDraftDto"])],
  ])("%s", (_name, misuse) => {
    expect(misuse).toThrow(FlowSyntaxError);
  });

  it("FlowSyntaxError has a stable code", () => {
    expect(new FlowSyntaxError("x").code).toBe("flow.syntax");
  });
});

describe("AC4 / AC8: removed forms do not exist", () => {
  it("removed forms do not exist", () => {
    expect(Object.keys(builder).sort()).toEqual([
      "FlowSyntaxError",
      "action",
      "agent",
      "anyOf",
      "caseOf",
      "group",
      "route",
      "router",
      "start",
      "toAction",
      "toAgent",
      "toFinish",
      "toRouter",
      "workflow",
    ]);
  });

  it("toAction begins a side path with the action", () => {
    expect(toAction(RefundCardAction).steps).toEqual([to(RefundCardAction, NodeKind.Action)]);
  });
});
