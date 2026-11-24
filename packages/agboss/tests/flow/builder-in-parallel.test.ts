import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type FlowPath } from "../../src/flow/ast.js";
import { FlowSyntaxError, skip } from "../../src/flow/builder.js";
import { flowLines } from "../../src/flow/print.js";
import { StepFailedError } from "../../src/graph/errors.js";
import {
  ChooserRouter,
  ChosenAAction,
  ChosenBAction,
  FirstAction,
  InParallelWorkflow,
  InParallelWorkflowStart,
  SecondAction,
  ThirdAgent,
} from "./runtime/fixtures/in-parallel.workflow.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { onStart, onAction, toAction, toAgent, toFinish, toRouter } from "../helpers/flow.js";

/** #1279a: what `.inParallel([…])` writes into the AST, and what it refuses. */

const stepsOf = (): readonly { readonly kind: StepKind }[] => {
  const declaration = declarationOf(InParallelWorkflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new TypeError("not a workflow");
  return declaration.options.flow[0]?.steps ?? [];
};

describe("#1279a: .inParallel([…]) in the AST", () => {
  it("each branch keeps its target, its kind and its skip()", () => {
    const step = stepsOf().find((candidate) => candidate.kind === StepKind.InParallel);
    expect(step).toMatchObject({
      kind: StepKind.InParallel,
      branches: [
        { target: FirstAction, targetKind: NodeKind.Action, skip: [] },
        { target: SecondAction, targetKind: NodeKind.Action, skip: [StepFailedError] },
        { target: ThirdAgent, targetKind: NodeKind.Agent, skip: [] },
      ],
    });
  });

  it("is followed by .join() only", () => {
    expect(stepsOf().map((step) => step.kind)).toEqual([
      StepKind.InParallel,
      StepKind.Join,
      StepKind.To,
      StepKind.To,
    ]);
    expect(() =>
      onStart(FirstAction)
        .inParallel([toAction(FirstAction)])
        .toAction(FirstAction),
    ).toThrow(FlowSyntaxError);
  });

  it("maxConcurrency is a positive integer", () => {
    expect(() =>
      onStart(FirstAction).inParallel([toAction(FirstAction)], { maxConcurrency: 0 }),
    ).toThrow(FlowSyntaxError);
    expect(() => onStart(FirstAction).inParallel([toAction(FirstAction)], { maxItems: 3 })).toThrow(
      FlowSyntaxError,
    );
    const step = onStart(FirstAction).inParallel([toAction(FirstAction)], { maxConcurrency: 2 })
      .steps[0];
    expect(step).toMatchObject({ maxConcurrency: 2 });
  });

  it("a branch is one entering step: no second step, no finish, no empty list", () => {
    expect(() => onStart(FirstAction).inParallel([])).toThrow(FlowSyntaxError);
    expect(() =>
      onStart(FirstAction).inParallel([toAction(FirstAction).toAction(SecondAction)]),
    ).toThrow(FlowSyntaxError);
    expect(() => onStart(FirstAction).inParallel([toFinish(FirstAction)])).toThrow(FlowSyntaxError);
    expect(() => onStart(FirstAction).inParallel(toAction(FirstAction))).toThrow(FlowSyntaxError);
  });

  it("skip() stands on a branch only", () => {
    expect(() => onAction(FirstAction).onError(StepFailedError, skip())).toThrow(FlowSyntaxError);
    expect(() => onStart(FirstAction).onError(StepFailedError, skip())).toThrow(FlowSyntaxError);
    // a branch that names a skip() is no side path of `.onError(E, …)`
    expect(() =>
      onStart(FirstAction).onError(
        StepFailedError,
        toAction(SecondAction).onError(StepFailedError, skip()),
      ),
    ).toThrow(FlowSyntaxError);
  });

  it("is printed as it is written", () => {
    const path = onStart(InParallelWorkflowStart)
      .inParallel([toAction(FirstAction), toAgent(ThirdAgent).onError(StepFailedError, skip())], {
        maxConcurrency: 2,
      })
      .join();
    expect(flowLines([path as FlowPath])).toEqual([
      "onStart(InParallelWorkflowStart)",
      "  .inParallel([toAction(FirstAction), toAgent(ThirdAgent).onError(StepFailedError, skip())], { maxConcurrency: 2 })",
      "  .join()",
    ]);
  });

  it("toRouter(R).chooseMany([…]) is a branch of its own: the router, and the branches it picks among", () => {
    const step = onStart(InParallelWorkflowStart)
      .inParallel([
        toAction(FirstAction),
        toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction), toAction(ChosenBAction)]),
      ])
      .join().steps[0];
    expect(step).toMatchObject({
      kind: StepKind.InParallel,
      branches: [
        { target: FirstAction, targetKind: NodeKind.Action },
        {
          target: ChooserRouter,
          targetKind: NodeKind.Router,
          chooses: [
            { target: ChosenAAction, targetKind: NodeKind.Action },
            { target: ChosenBAction, targetKind: NodeKind.Action },
          ],
        },
      ],
    });
  });

  it("chooseMany stands right after toRouter(R), once, and nowhere else", () => {
    expect(() => toAction(FirstAction).chooseMany([toAction(ChosenAAction)])).toThrow(
      FlowSyntaxError,
    );
    expect(() => onStart(InParallelWorkflowStart).toRouter(ChooserRouter).chooseMany([])).toThrow(
      FlowSyntaxError,
    );
    const chosen = toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction)]);
    expect(() => chosen.chooseMany([toAction(ChosenBAction)])).toThrow(FlowSyntaxError);
    // a router branch without its choice, a router among the chosen, a skip() on the router
    expect(() => onStart(FirstAction).inParallel([toRouter(ChooserRouter)])).toThrow(
      FlowSyntaxError,
    );
    expect(() =>
      toRouter(ChooserRouter).chooseMany([
        toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction)]),
      ]),
    ).toThrow(FlowSyntaxError);
    expect(() => toRouter(ChooserRouter).onError(StepFailedError, skip())).not.toThrow();
    expect(() =>
      toRouter(ChooserRouter)
        .onError(StepFailedError, skip())
        .chooseMany([toAction(ChosenAAction)]),
    ).toThrow(FlowSyntaxError);
  });

  it("a branch with chooseMany is no side path of .onError(E, …)", () => {
    expect(() =>
      onStart(FirstAction).onError(
        StepFailedError,
        toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction)]),
      ),
    ).toThrow(FlowSyntaxError);
  });

  it("is printed with its choice", () => {
    const path = onStart(InParallelWorkflowStart)
      .inParallel([toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction)])])
      .join();
    expect(flowLines([path as FlowPath])[1]).toBe(
      "  .inParallel([toRouter(ChooserRouter).chooseMany([toAction(ChosenAAction)])])",
    );
  });
});
