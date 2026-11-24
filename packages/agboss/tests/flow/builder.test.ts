import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type Step } from "../../src/flow/ast.js";
import * as builder from "../../src/flow/builder.js";
import {
  FlowSyntaxError,
  caseOf,
  route,
  onStart,
  toAction,
  toAgent,
  toFinish,
  toRouter,
} from "../../src/flow/builder.js";
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
  OrderAction,
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

const to = (target: abstract new () => unknown, targetKind: NodeKind): Step => ({
  kind: StepKind.To,
  target,
  targetKind,
});

describe("AC1: a path starts with its source's kind", () => {
  it("records start, agent, router and action sources", () => {
    expect(onStart(OfferWorkflowStart).source).toEqual({
      kind: NodeKind.Start,
      node: OfferWorkflowStart,
    });
    expect(builder.onAgent(ReviewerAgent).source).toEqual({
      kind: NodeKind.Agent,
      node: ReviewerAgent,
    });
    expect(builder.onRouter(MainRouter).source).toEqual({
      kind: NodeKind.Router,
      node: MainRouter,
    });
    expect(builder.onAction(SendOfferAction).source).toEqual({
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
      to(ArticleDraftAgent, NodeKind.Agent),
      to(DraftReviewerAgent, NodeKind.Agent),
      to(WriterAgent, NodeKind.Agent),
      to(FinalReviewerAgent, NodeKind.Agent),
      to(ArticleWorkflowFinish, NodeKind.Finish),
    ]);
  });

  it("records toRouter and toAction with their kinds", () => {
    expect(chatPaths[0].steps.at(-1)).toEqual(to(MainRouter, NodeKind.Router));
    expect(orderPaths[0].steps[0]).toEqual(to(ReserveStockAction, NodeKind.Action));
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
            path: { steps: [to(ChatWorkflowFinish, NodeKind.Finish)] },
          },
          { target: NoReplyWorkflowFinish, path: { steps: [] } },
        ],
      },
    ]);
    expect(chatPaths[0].source.node).toBe(IntakeWorkflowStart);
  });
});

describe("AC7: onError side paths (#272 examples 2a and 3)", () => {
  it("puts the side path right after the step", () => {
    const [, reviewerPath] = offerPaths;
    const [switchStep] = reviewerPath.steps;

    expect(switchStep).toEqual({
      kind: StepKind.Switch,
      cases: [
        {
          dto: ChangesRequestedDto,
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
              to(ReviewerAgent, NodeKind.Agent),
            ],
          },
        },
        {
          dto: DraftApprovedDto,
          path: {
            steps: [
              to(SendOfferAction, NodeKind.Action),
              to(OfferSentWorkflowFinish, NodeKind.Finish),
            ],
          },
        },
      ],
    });
    expect(offerPaths[0].steps).toEqual([
      to(DraftAgent, NodeKind.Agent),
      to(ReviewerAgent, NodeKind.Agent),
    ]);
  });

  it("nests an onError inside a side path for a failed rollback", () => {
    expect(orderPaths[0].steps).toEqual([
      to(ReserveStockAction, NodeKind.Action),
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
      to(OrderAction, NodeKind.Action),
      to(OrderWorkflowFinish, NodeKind.Finish),
    ]);
    expect(orderPaths[0].source.node).toBe(OrderWorkflowStart);
  });
});

describe("AC7: a side path may start with any transition", () => {
  it("toFinish ends the side path at a finish", () => {
    const shipped = builder
      .onAction(ShipOrderAction)
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
      .onAgent(EditorAgent)
      .onError(VisitsLimitExceededError, toAgent(DraftAgent).toAgent(ReviewerAgent));

    expect(edited.steps[0]).toEqual({
      kind: StepKind.OnError,
      error: VisitsLimitExceededError,
      path: {
        steps: [to(DraftAgent, NodeKind.Agent), to(ReviewerAgent, NodeKind.Agent)],
      },
    });
  });

  it("toRouter continues the side path with the router's chooseOne", () => {
    const escalated = builder
      .onAgent(EditorAgent)
      .onError(
        VisitsLimitExceededError,
        toRouter(MainRouter).chooseOne(route(ScoutAgent).toFinish(ChatWorkflowFinish)),
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
                path: { steps: [to(ChatWorkflowFinish, NodeKind.Finish)] },
              },
            ],
          },
        ],
      },
    });
  });
});

describe("#299 S54: a case holds its class only", () => {
  it("records a caseOf with its class only — { about } is gone (#1277)", () => {
    const aboutCase = caseOf(ChangesRequestedDto).toAgent(EditorAgent);

    expect(
      callUntyped(builder.onAgent(ReviewerAgent), "switch", [aboutCase, caseOf(DraftApprovedDto)]),
    ).toEqual(
      expect.objectContaining({
        steps: [
          {
            kind: StepKind.Switch,
            cases: [
              { dto: ChangesRequestedDto, path: { steps: [to(EditorAgent, NodeKind.Agent)] } },
              { dto: DraftApprovedDto, path: { steps: [] } },
            ],
          },
        ],
      }),
    );
  });

  it("records a .toOneOf([…]) as its side paths, no DTO in it (#1275a)", () => {
    const edits = builder.toAgent(EditorAgent);
    const sends = builder.toFinish(OfferFailedWorkflowFinish);

    expect(builder.onAgent(ReviewerAgent).toOneOf([edits, sends])).toEqual(
      expect.objectContaining({
        steps: [
          {
            kind: StepKind.OneOf,
            branches: [
              { steps: [to(EditorAgent, NodeKind.Agent)] },
              { steps: [to(OfferFailedWorkflowFinish, NodeKind.Finish)] },
            ],
          },
        ],
      }),
    );
  });

  it("records an .onFinish as the finish class and its side path (#1275b)", () => {
    expect(
      callUntyped(builder.onAgent(ReviewerAgent), "onFinish", [
        OfferFailedWorkflowFinish,
        builder.toAgent(EditorAgent),
      ]),
    ).toEqual(
      expect.objectContaining({
        steps: [
          {
            kind: StepKind.OnFinish,
            finish: OfferFailedWorkflowFinish,
            path: { steps: [to(EditorAgent, NodeKind.Agent)] },
          },
        ],
      }),
    );
  });

  it("`.returns` is gone: values are derived from the steps' declarations (#1270)", () => {
    expect(() => callUntyped(builder.onAgent(DraftAgent), "returns", [OfferDraftDto])).toThrow(
      TypeError,
    );
    expect(Object.keys(StepKind)).not.toContain("Returns");
  });
});

describe("paths are immutable", () => {
  it("a builder continued twice gives two independent paths, frozen", () => {
    const shortlisted = onStart(OfferWorkflowStart);

    const drafted = shortlisted.toAgent(DraftAgent);
    const failed = shortlisted.toFinish(OfferFailedWorkflowFinish);

    expect(shortlisted.steps).toHaveLength(0);
    expect(drafted.steps.at(-1)).toEqual(to(DraftAgent, NodeKind.Agent));
    expect(failed.steps.at(-1)).toEqual(to(OfferFailedWorkflowFinish, NodeKind.Finish));
    expect(Object.isFrozen(drafted.steps)).toBe(true);
    expect(Reflect.get(route(EditorAgent), "source")).toBeUndefined();
  });
});

describe("misuse from untyped code fails with FlowSyntaxError", () => {
  const reviewer = builder.onAgent(ReviewerAgent);
  const router = builder.onRouter(MainRouter);
  const edited = builder.onAgent(EditorAgent);

  it.each([
    ["switch takes caseOf paths", () => callUntyped(reviewer, "switch", [route(DraftAgent)])],
    [
      "toOneOf takes an array of two or more side paths",
      () => callUntyped(reviewer, "toOneOf", [[builder.toAgent(EditorAgent)]]),
    ],
    [
      "toOneOf takes side paths, not caseOf",
      () => callUntyped(reviewer, "toOneOf", [[caseOf(ProfileDto), builder.toAgent(EditorAgent)]]),
    ],
    ["chooseOne takes route paths", () => callUntyped(router, "chooseOne", [caseOf(ProfileDto)])],
    [
      "onError takes a toAction side path",
      () => callUntyped(edited, "onError", [CarrierError, route(DraftAgent)]),
    ],
  ])("%s", (_name, misuse) => {
    expect(misuse).toThrow(FlowSyntaxError);
  });

  it("FlowSyntaxError has a stable code", () => {
    expect(new FlowSyntaxError({ message: "x" }).code).toBe("flow.syntax");
  });
});

describe("AC4 / AC8: removed forms do not exist", () => {
  it("removed forms do not exist", () => {
    expect(Object.keys(builder).sort()).toEqual([
      "FlowSyntaxError",
      "anyOf",
      "caseOf",
      "group",
      "onAction",
      "onAgent",
      "onExternalTask",
      "onRouter",
      "onStart",
      "onWorkflow",
      "route",
      "toAction",
      "toAgent",
      "toExternalTask",
      "toFinish",
      "toRouter",
      "toWorkflow",
    ]);
  });

  it("toAction begins a side path with the action", () => {
    expect(toAction(RefundCardAction).steps).toEqual([to(RefundCardAction, NodeKind.Action)]);
  });
});
