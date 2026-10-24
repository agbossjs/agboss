import {
  ChildPlacement,
  EmptyEnvironment,
  LimitExceededError,
  oneOf,
  ThisWorkflow,
  Workflow,
  WorkflowStart,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { caseOf, route, start, toAction } from "../../../helpers/flow.js";
import {
  ChainDoneWorkflowFinish,
  CountDoneDto,
  CountDoneWorkflowFinish,
  CountdownAction,
  CountDto,
  CountStoppedDto,
  CountStoppedWorkflowFinish,
  DeeperRouter,
  DepthStoppedAction,
  LinkAgent,
  LinkDoneDto,
  LinkDto,
} from "./recursion.workflow.js";

/**
 * #333 PR 3 — a recursion whose every level runs on any instance (`ChildPlacement.AnyInstance`):
 * `remote-countdown-workflow` (`maxDepth: 3`) goes one level deeper by code until its count is
 * spent — level 3 runs on a worker, and its launch of level 4 is refused there; `remote-chain-workflow`
 * (`maxDepth: 2`) a code router whose route launches `ThisWorkflow` — on the last level, on a worker,
 * that route is not ready (the soft stop).
 */

@WorkflowStart({
  name: "remote-countdown-workflow-start",
  description: "A count, each level on any instance",
  input: CountDto,
})
export class RemoteCountdownWorkflowStart {}

@Workflow({
  name: "remote-countdown-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteCountdownWorkflowStart)
      .returns(CountDto)
      .toAction(CountdownAction)
      .returns(oneOf(CountDto, CountDoneDto))
      .switch(
        caseOf(CountDto)
          .toWorkflow(ThisWorkflow, { placement: ChildPlacement.AnyInstance })
          .onError(
            LimitExceededError,
            toAction(DepthStoppedAction)
              .returns(CountStoppedDto)
              .toFinish(CountStoppedWorkflowFinish),
          )
          .returns(oneOf(CountDoneDto, CountStoppedDto))
          .switch(
            caseOf(CountDoneDto)
              .toFinish(CountDoneWorkflowFinish),
            caseOf(CountStoppedDto)
              .toFinish(CountStoppedWorkflowFinish),
          ),
        caseOf(CountDoneDto)
          .toFinish(CountDoneWorkflowFinish),
      ),
  ],
  maxDepth: 3,
})
export class RemoteCountdownWorkflow {}

@WorkflowStart({
  name: "remote-chain-workflow-start",
  description: "A link, each level on any instance",
  input: LinkDto,
})
export class RemoteChainWorkflowStart {}

@Workflow({
  name: "remote-chain-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteChainWorkflowStart)
      .returns(LinkDto)
      .toRouter(DeeperRouter)
      .chooseOne(
        route(ThisWorkflow, { placement: ChildPlacement.AnyInstance })
          .returns(LinkDoneDto)
          .toFinish(ChainDoneWorkflowFinish),
        route(LinkAgent)
          .returns(LinkDoneDto)
          .toFinish(ChainDoneWorkflowFinish),
      ),
  ],
  maxDepth: 2,
})
export class RemoteChainWorkflow {}

/** On the built-in in-memory stores: the test's instances share the queue. */
@Application({
  name: "remote-recursion-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RemoteCountdownWorkflow, RemoteChainWorkflow],
  defaults: { router: { model: "typesafe/jev-1.13" } },
  budgets: TEST_BUDGETS,
})
export class RemoteRecursionApplication {}
