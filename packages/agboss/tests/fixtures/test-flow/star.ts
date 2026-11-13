import type { Class } from "../../../src/components/injection.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import type { FlowPath } from "../../../src/flow/ast.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { route, start } from "../../helpers/flow.js";
import { NoAnswer, TestAnswer, TestChat } from "./test.flow.js";

/**
 * A star flow over the given text agents (test workflows): chat workflow start → a Jev router
 * "main-router" → an agent → the answer; or no answer.
 */
export function starOf(...agents: readonly [Class, ...Class[]]): readonly FlowPath[] {
  @Router({
    name: "main-router",
    description: "Sends the message to an agent, or ends",
    decidedBy: DecidedBy.Model,
    prompt: "Pick who handles the message.",
    model: "typesafe/jev-1.13",
    input: { message: WorkflowStartTextDto },
    maxVisits: 10,
    routes: [
      { prompt: "Stop without an answer: nothing to do", target: NoAnswer },
      ...agents.map((agent) => ({ prompt: `${agent.name} work`, target: agent })),
    ],
  })
  class MainRouter {}
  return [
    start(TestChat)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter)
      .chooseOne(
        route(NoAnswer),
        ...agents.map((agent) =>
          route(agent)
            .toFinish(TestAnswer),
        ),
      ),
  ];
}
