import {
  ChildPlacement,
  DecidedBy,
  EmptyEnvironment,
  LimitExceededError,
  Router,
  Workflow,
  WorkflowStart,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { caseOf, route, onStart, toAction } from "../../../helpers/flow.js";
import {
  ChainDoneWorkflowFinish,
  CountDoneDto,
  CountDoneWorkflowFinish,
  CountdownAction,
  CountDto,
  CountStoppedDto,
  CountStoppedWorkflowFinish,
  DepthStoppedAction,
  LinkAgent,
  LinkDto,
} from "./recursion.workflow.js";

/**
 * #333 PR 3 — a recursion whose every level runs on any instance (`ChildPlacement.AnyWorker`):
 * `remote-countdown-workflow` (`maxDepth: 3`) goes one level deeper by code until its count is
 * spent — level 3 runs on a worker, and its launch of level 4 is refused there; `remote-chain-workflow`
 * (`maxDepth: 2`) a code router whose route launches itself — on the last level, on a worker,
 * that route is not ready (the soft stop).
 */

@WorkflowStart({
  name: "remote-countdown-workflow-start",
  description: "A count, each level on any instance",
  input: CountDto,
})
export class RemoteCountdownWorkflowStart {}

@Workflow({
  placement: ChildPlacement.AnyWorker,
  name: "remote-countdown-workflow",
  version: "1.0.0",
  flow: [
    onStart(RemoteCountdownWorkflowStart)
      .toAction(CountdownAction)
      .switch(
        caseOf(CountDto)
          .toWorkflow(() => RemoteCountdownWorkflow)
          .onError(
            LimitExceededError,
            toAction(DepthStoppedAction)
              .toFinish(CountStoppedWorkflowFinish),
          )
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

/** Always one link further: on the last level that route is not ready. */
@Router({
  name: "remote-deeper-router",
  description: "Always goes one link further, on any instance",
  decidedBy: DecidedBy.Code,
  input: { link: LinkDto },
  maxVisits: 1,
  routes: [{ target: () => RemoteChainWorkflow }, { target: LinkAgent }],
})
export class RemoteDeeperRouter {
  route(): unknown {
    return RemoteChainWorkflow;
  }
}

@Workflow({
  placement: ChildPlacement.AnyWorker,
  name: "remote-chain-workflow",
  version: "1.0.0",
  flow: [
    onStart(RemoteChainWorkflowStart)
      .toRouter(RemoteDeeperRouter)
      .chooseOne(
        route(() => RemoteChainWorkflow)
          .toFinish(ChainDoneWorkflowFinish),
        route(LinkAgent)
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
