import { OneOf, Text } from "../../../../src/dto/index.js";
import {
  Action,
  DecidedBy,
  Router,
  RouterFailedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../../src/index.js";
import { LimitExceededError } from "../../../../src/graph/limits.js";
import { route, start, toFinish } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { EmptyEnvironment } from "../../../../src/index.js";

/**
 * #280 S19 — a code router whose answer the test picks: a target, a class outside its routes (what
 * a cast lets through), a list, a domain error, a limit. Its routes' `.onError` takes the service's
 * domain error through the cause chain of `RouterFailedError`.
 */

/** What the test makes `route()` do. */
export const ANSWERS = [
  "left",
  "right",
  "outside",
  "list",
  "nothing",
  "domain-error",
  "crash",
  "limit",
] as const;

export type Answer = (typeof ANSWERS)[number];

export class AskDto {
  @OneOf({ values: ANSWERS, prompt: "what the router answers" })
  answer!: Answer;
}

export class DoneDto {
  @Text({ prompt: "which way the execution went" })
  text!: string;
}

/** The service behind the router is down: a domain error. */
export class LedgerDownError extends Error {}

@WorkflowStart({ name: "ask-workflow-start", description: "What to answer", input: AskDto })
export class AskWorkflowStart {}

@Action({ name: "left-action", description: "Goes left", input: { ask: AskDto }, output: DoneDto })
export class LeftAction {
  execute(): Promise<DoneDto> {
    return Promise.resolve({ text: "left" });
  }
}

@Action({
  name: "right-action",
  description: "Goes right",
  input: { ask: AskDto },
  output: DoneDto,
})
export class RightAction {
  execute(): Promise<DoneDto> {
    return Promise.resolve({ text: "right" });
  }
}

@WorkflowFinish({ name: "done-workflow-finish", description: "Done", output: DoneDto })
export class DoneWorkflowFinish {}

@WorkflowFinish({ name: "held-workflow-finish", description: "Held", output: AskDto })
export class HeldWorkflowFinish {}

@WorkflowFinish({ name: "refused-workflow-finish", description: "Refused", output: AskDto })
export class RefusedWorkflowFinish {}

const answerOf = (answer: Answer): unknown => {
  switch (answer) {
    case "left":
      return LeftAction;
    case "right":
      return RightAction;
    case "outside":
      return DoneWorkflowFinish;
    case "list":
      return [LeftAction];
    case "nothing":
      return undefined;
    case "domain-error":
      throw new LedgerDownError("the ledger is down");
    case "crash":
      throw new TypeError("route() has a bug");
    case "limit":
      throw new LimitExceededError({ key: "maxSteps", limit: 1, actual: 2 }, ["ask-router"], 0);
  }
};

/** Decides by its input; typed loosely on purpose so it can return what `Route<R>` forbids. */
@Router({
  name: "ask-router",
  description: "Answers what the input says",
  decidedBy: DecidedBy.Code,
  input: { ask: AskDto },
  routes: [{ target: LeftAction }, { target: RightAction }],
})
export class AskRouter {
  route(input: { readonly ask: { readonly value: AskDto } }): unknown {
    return answerOf(input.ask.value.answer);
  }
}

@Workflow({
  name: "ask-workflow",
  version: "1.0.0",
  flow: [
    start(AskWorkflowStart)
      .returns(AskDto)
      .toRouter(AskRouter)
      .onError(LedgerDownError, toFinish(HeldWorkflowFinish))
      .chooseOne(
        route(LeftAction)
          .returns(DoneDto)
          .toFinish(DoneWorkflowFinish),
        route(RightAction)
          .returns(DoneDto)
          .toFinish(DoneWorkflowFinish),
      ),
  ],
})
export class AskWorkflow {}

@Application({
  name: "ask-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AskWorkflow],
  budgets: TEST_BUDGETS,
})
export class AskApplication {}

/** The same router with a side path for any of its failures: `RouterFailedError` takes both. */
@Workflow({
  name: "ask-caught-workflow",
  version: "1.0.0",
  flow: [
    start(AskWorkflowStart)
      .returns(AskDto)
      .toRouter(AskRouter)
      .onError(RouterFailedError, toFinish(RefusedWorkflowFinish))
      .chooseOne(
        route(LeftAction)
          .returns(DoneDto)
          .toFinish(DoneWorkflowFinish),
        route(RightAction)
          .returns(DoneDto)
          .toFinish(DoneWorkflowFinish),
      ),
  ],
})
export class AskCaughtWorkflow {}

@Application({
  name: "ask-caught-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AskCaughtWorkflow],
  budgets: TEST_BUDGETS,
})
export class AskCaughtApplication {}
