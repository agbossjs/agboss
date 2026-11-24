import { describe, expect, it } from "vitest";
import { analyseWorkflow, checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { caseOf, onRouter, onStart, toAgent, toFinish } from "../../../src/flow/builder.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  AskResumeWorkflowFinish,
  ChatWorkflow,
  ChatWorkflowFinish,
  IntakeWorkflowStart,
  MainRouter,
  NoReplyWorkflowFinish,
  ProfilerAgent,
  ScoutAgent,
} from "../fixtures/chat.fixture.js";
import { ProfileDto, ResumeMissingDto } from "../fixtures/dtos.js";

/** #1278a: `.onRoute(subPath)` is the same choice as `.chooseOne(route(…)…)`, so the same graph. */

@Workflow({
  name: "chat-on-route-workflow",
  version: "1.0.0",
  flow: [
    onStart(IntakeWorkflowStart).toRouter(MainRouter),
    onRouter(MainRouter)
      .onRoute(
        toAgent(ProfilerAgent).switch(
          caseOf(ProfileDto).toRouter(MainRouter),
          caseOf(ResumeMissingDto).toFinish(AskResumeWorkflowFinish),
        ),
      )
      .onRoute(toAgent(ScoutAgent).toFinish(ChatWorkflowFinish))
      .onRoute(toFinish(NoReplyWorkflowFinish)),
  ],
})
class ChatOnRouteWorkflow {}

describe("1278a: a flow written with .onRoute(…)", () => {
  it("passes every rule, as the .chooseOne(route(…)…) flow does", () => {
    expect(checkWorkflow(ChatOnRouteWorkflow)).toMatchObject({ errors: [], warnings: [] });
  });

  it("has the graph of the .chooseOne(route(…)…) flow", () => {
    const written = analyseWorkflow(ChatOnRouteWorkflow).graph;
    const old = analyseWorkflow(ChatWorkflow).graph;
    expect(written.edges).toEqual(old.edges);
    expect([...written.nodes.keys()]).toEqual([...old.nodes.keys()]);
  });
});
