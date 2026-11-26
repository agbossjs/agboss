import { ComponentKind } from "../../src/flow/runtime/records.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { StepKind, type Step, type ToStep } from "../../src/flow/ast.js";
import * as builder from "../../src/flow/builder.js";
import {
  onStart,
  toAction,
  toAgent,
  toFinish,
  toRouter,
  toWorkflow,
} from "../../src/flow/builder.js";
import type { PathBuilder } from "../../src/flow/path-builder.js";
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
  ChatWorkflow,
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

const to = (target: abstract new () => unknown, targetKind: ToStep["targetKind"]): Step => ({
  kind: StepKind.To,
  target,
  targetKind,
});

describe("AC1: a path starts with its source's kind", () => {
  it("records start, agent, router and action sources", () => {
    expect(onStart(OfferWorkflowStart).source).toEqual({
      kind: ComponentKind.WorkflowStart,
      node: OfferWorkflowStart,
    });
    expect(builder.onAgent(ReviewerAgent).source).toEqual({
      kind: ComponentKind.Agent,
      node: ReviewerAgent,
    });
    expect(builder.onRouter(MainRouter).source).toEqual({
      kind: ComponentKind.Router,
      node: MainRouter,
    });
    expect(builder.onAction(SendOfferAction).source).toEqual({
      kind: ComponentKind.Action,
      node: SendOfferAction,
    });
  });
});

describe("AC2: transitions name the target's kind", () => {
  it("records each step of a straight path in order (#272 example 2b)", () => {
    const [path] = articlePaths;

    expect(path.source).toEqual({ kind: ComponentKind.WorkflowStart, node: ArticleWorkflowStart });
    expect(path.steps).toEqual([
      to(ArticleDraftAgent, ComponentKind.Agent),
      to(DraftReviewerAgent, ComponentKind.Agent),
      to(WriterAgent, ComponentKind.Agent),
      to(FinalReviewerAgent, ComponentKind.Agent),
      to(ArticleWorkflowFinish, ComponentKind.WorkflowFinish),
    ]);
  });

  it("records toRouter and toAction with their kinds", () => {
    expect(chatPaths[0].steps.at(-1)).toEqual(to(MainRouter, ComponentKind.Router));
    expect(orderPaths[0].steps[0]).toEqual(to(ReserveStockAction, ComponentKind.Action));
  });
});

describe("AC3 / AC5 / AC6: router own path, onRoute and toOneOf (#272 example 1)", () => {
  it("builds onRoute routes with their sub-paths and a toOneOf inside a route", () => {
    const [, mainRouterPath] = chatPaths;

    expect(mainRouterPath.source).toEqual({ kind: ComponentKind.Router, node: MainRouter });
    expect(mainRouterPath.steps).toEqual([
      {
        kind: StepKind.ChooseOne,
        routes: [
          {
            target: ProfilerAgent,
            path: {
              steps: [
                {
                  kind: StepKind.OneOf,
                  branches: [
                    { steps: [to(MainRouter, ComponentKind.Router)] },
                    { steps: [to(AskResumeWorkflowFinish, ComponentKind.WorkflowFinish)] },
                  ],
                },
              ],
            },
          },
          {
            target: ScoutAgent,
            path: { steps: [to(ChatWorkflowFinish, ComponentKind.WorkflowFinish)] },
          },
          { target: NoReplyWorkflowFinish, path: { steps: [] } },
        ],
      },
    ]);
    expect(chatPaths[0].source.node).toBe(IntakeWorkflowStart);
  });
});

describe("1278a: .onRoute(subPath) builds the routes of a router", () => {
  const [, mainRouterPath] = chatPaths;
  const entry = (): PathBuilder => builder.onRouter(MainRouter) as never;

  it("one .onRoute per route is one choice", () => {
    const built = builder
      .onRouter(MainRouter)
      .onRoute(
        toAgent(ProfilerAgent).toOneOf([toRouter(MainRouter), toFinish(AskResumeWorkflowFinish)]),
      )
      .onRoute(toAgent(ScoutAgent).toFinish(ChatWorkflowFinish))
      .onRoute(toFinish(NoReplyWorkflowFinish));
    expect(built).toMatchObject({ source: mainRouterPath.source });
    expect(built.steps).toEqual(mainRouterPath.steps);
  });

  it("a thunk target is read when the route's target is, never while the path is built", () => {
    let reads = 0;
    const side = toWorkflow(() => {
      reads += 1;
      return ChatWorkflow;
    });
    const built = entry().onRoute(side);
    const [step] = built.steps;
    expect(reads).toBe(0);
    expect(step?.kind === StepKind.ChooseOne && step.routes[0]?.target).toBe(ChatWorkflow);
    expect(reads).toBe(1);
  });

  it.each<[string, () => unknown]>([
    ["a path that is no side path", () => entry().onRoute(builder.onAgent(ProfilerAgent))],
    ["a value that is no path", () => entry().onRoute({})],
  ])("%s is a syntax error", (_label, call) => {
    expect(call).toThrow(ConfigError.FlowSyntax);
  });
});

describe("AC7: onError side paths (#272 examples 2a and 3)", () => {
  it("puts the side path right after the step", () => {
    const [, reviewerPath] = offerPaths;
    const [oneOfStep] = reviewerPath.steps;

    expect(oneOfStep).toEqual({
      kind: StepKind.OneOf,
      branches: [
        {
          steps: [
            to(EditorAgent, ComponentKind.Agent),
            {
              kind: StepKind.OnError,
              error: VisitsLimitExceededError,
              path: {
                steps: [
                  to(NotifyRecruiterAction, ComponentKind.Action),
                  to(OfferFailedWorkflowFinish, ComponentKind.WorkflowFinish),
                ],
              },
            },
            to(ReviewerAgent, ComponentKind.Agent),
          ],
        },
        {
          steps: [
            to(SendOfferAction, ComponentKind.Action),
            to(OfferSentWorkflowFinish, ComponentKind.WorkflowFinish),
          ],
        },
      ],
    });
    expect(offerPaths[0].steps).toEqual([
      to(DraftAgent, ComponentKind.Agent),
      to(ReviewerAgent, ComponentKind.Agent),
    ]);
  });

  it("nests an onError inside a side path for a failed rollback", () => {
    expect(orderPaths[0].steps).toEqual([
      to(ReserveStockAction, ComponentKind.Action),
      to(ShipOrderAction, ComponentKind.Action),
      {
        kind: StepKind.OnError,
        error: CarrierError,
        path: {
          steps: [
            to(RefundCardAction, ComponentKind.Action),
            {
              kind: StepKind.OnError,
              error: PaymentProviderError,
              path: {
                steps: [
                  to(NotifyFinanceTeamAction, ComponentKind.Action),
                  to(OrderFailedWorkflowFinish, ComponentKind.WorkflowFinish),
                ],
              },
            },
            to(ReleaseStockAction, ComponentKind.Action),
            to(OrderFailedWorkflowFinish, ComponentKind.WorkflowFinish),
          ],
        },
      },
      to(OrderAction, ComponentKind.Action),
      to(OrderWorkflowFinish, ComponentKind.WorkflowFinish),
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
        path: { steps: [to(OrderFailedWorkflowFinish, ComponentKind.WorkflowFinish)] },
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
        steps: [to(DraftAgent, ComponentKind.Agent), to(ReviewerAgent, ComponentKind.Agent)],
      },
    });
  });

  it("toRouter continues the side path with the router's onRoute", () => {
    const escalated = builder.onAgent(EditorAgent).onError(
      VisitsLimitExceededError,
      toRouter(MainRouter)
        .onRoute(toAgent(ScoutAgent).toFinish(ChatWorkflowFinish))
        .onRoute(
          toAgent(ProfilerAgent).toOneOf([toRouter(MainRouter), toFinish(AskResumeWorkflowFinish)]),
        )
        .onRoute(toFinish(NoReplyWorkflowFinish)),
    );

    expect(escalated.steps[0]).toEqual({
      kind: StepKind.OnError,
      error: VisitsLimitExceededError,
      path: {
        steps: [
          to(MainRouter, ComponentKind.Router),
          {
            kind: StepKind.ChooseOne,
            routes: [
              {
                target: ScoutAgent,
                path: { steps: [to(ChatWorkflowFinish, ComponentKind.WorkflowFinish)] },
              },
              {
                target: ProfilerAgent,
                path: {
                  steps: [
                    {
                      kind: StepKind.OneOf,
                      branches: [
                        { steps: [to(MainRouter, ComponentKind.Router)] },
                        { steps: [to(AskResumeWorkflowFinish, ComponentKind.WorkflowFinish)] },
                      ],
                    },
                  ],
                },
              },
              { target: NoReplyWorkflowFinish, path: { steps: [] } },
            ],
          },
        ],
      },
    });
  });
});

describe("#299 S54: a branch holds its path only", () => {
  it("records a .toOneOf([…]) as its side paths, no DTO in it (#1275a)", () => {
    const edits = builder.toAgent(EditorAgent);
    const sends = builder.toFinish(OfferFailedWorkflowFinish);

    expect(builder.onAgent(ReviewerAgent).toOneOf([edits, sends])).toEqual(
      expect.objectContaining({
        steps: [
          {
            kind: StepKind.OneOf,
            branches: [
              { steps: [to(EditorAgent, ComponentKind.Agent)] },
              { steps: [to(OfferFailedWorkflowFinish, ComponentKind.WorkflowFinish)] },
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
            path: { steps: [to(EditorAgent, ComponentKind.Agent)] },
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
    expect(drafted.steps.at(-1)).toEqual(to(DraftAgent, ComponentKind.Agent));
    expect(failed.steps.at(-1)).toEqual(
      to(OfferFailedWorkflowFinish, ComponentKind.WorkflowFinish),
    );
    expect(Object.isFrozen(drafted.steps)).toBe(true);
    expect(Reflect.get(toAgent(EditorAgent), "source")).toBeUndefined();
  });
});

describe("misuse from untyped code fails with ConfigError.FlowSyntax", () => {
  const reviewer = builder.onAgent(ReviewerAgent);
  const router = builder.onRouter(MainRouter);
  const edited = builder.onAgent(EditorAgent);

  it.each([
    [
      "toOneOf takes an array of two or more side paths",
      () => callUntyped(reviewer, "toOneOf", [[builder.toAgent(EditorAgent)]]),
    ],
    [
      "toOneOf takes side paths, not a flow path",
      () =>
        callUntyped(reviewer, "toOneOf", [
          [builder.onAgent(ProfilerAgent), builder.toAgent(EditorAgent)],
        ]),
    ],
    ["onRoute takes a side path", () => callUntyped(router, "onRoute", [{}])],
    [
      "onError takes a side path",
      () => callUntyped(edited, "onError", [CarrierError, builder.onAgent(DraftAgent)]),
    ],
  ])("%s", (_name, misuse) => {
    expect(misuse).toThrow(ConfigError.FlowSyntax);
  });

  it("ConfigError.FlowSyntax has a stable code", () => {
    expect(new ConfigError.FlowSyntax({ message: "x" }).code).toBe("config.flow-syntax");
  });
});

describe("AC4 / AC8: removed forms do not exist", () => {
  it("removed forms do not exist", () => {
    expect(Object.keys(builder).sort()).toEqual([
      "forEachItem",
      "inParallel",
      "onAction",
      "onAgent",
      "onExternalTask",
      "onRouter",
      "onStart",
      "onWorkflow",
      "skip",
      "toAction",
      "toAgent",
      "toExternalTask",
      "toFinish",
      "toRouter",
      "toWorkflow",
    ]);
  });

  it("toAction begins a side path with the action", () => {
    expect(toAction(RefundCardAction).steps).toEqual([to(RefundCardAction, ComponentKind.Action)]);
  });
});
