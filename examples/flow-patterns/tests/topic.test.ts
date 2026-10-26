import { describe, expect } from "vitest";
import {
  failWith,
  ModelFailure,
  replyWith,
  testWith,
  type ModelRequest,
} from "@agboss/core/testing";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { MergeAgent } from "../src/topic/agents/merge.agent.js";
import { ResearcherAgent } from "../src/topic/agents/researcher.agent.js";
import { TopicReportDto } from "../src/topic/dtos/topic-report.dto.js";
import { TopicTooBroadDto } from "../src/topic/dtos/topic-too-broad.dto.js";
import { TopicResearchWorkflow } from "../src/topic/topic-research.workflow.js";
import { TopicFailedWorkflowFinish } from "../src/topic/workflow-finishes/topic-failed.workflow-finish.js";
import { TopicReportWorkflowFinish } from "../src/topic/workflow-finishes/topic-report.workflow-finish.js";
import { TopicResearchWorkflowStart } from "../src/topic/workflow-starts/topic-research.workflow-start.js";

/** Recursion (#264): each subtopic researched by the workflow itself, at most three levels deep. */

const test = testWith(FlowPatternsApplication);

const textOf = (request: ModelRequest): string =>
  typeof request.input === "string" ? request.input : JSON.stringify(request.input);

const titleIn = (request: ModelRequest): string =>
  /"title": "([\w ]+)"/.exec(textOf(request))?.[1] ?? "?";

/** Too broad while the schema allows it (`TopicTooBroadDto` is gone on the last level). */
const researcher = (request: ModelRequest) => {
  const title = titleIn(request);
  if (title === "robots 1") return failWith(ModelFailure.Timeout);
  const canSplit =
    request.kind === "chat" &&
    request.tools.some((tool) => tool.function.name === "answer-topic-too-broad-dto");
  return canSplit && !title.startsWith("robots")
    ? replyWith(TopicTooBroadDto, { subtopics: [`${title} 1`, `robots 1`] })
    : replyWith(TopicReportDto, { title, text: `a report on ${title}` });
};

const merger = (request: ModelRequest) =>
  replyWith(TopicReportDto, { title: titleIn(request), text: "merged" });

describe("a workflow that researches its subtopics itself", () => {
  test("three levels; a failed subtopic is its own result; the last level only reports", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ResearcherAgent).thenAnswer(researcher);
    mockLlm(MergeAgent).thenAnswer(merger);

    const result = await app.execute(TopicResearchWorkflowStart, { title: "ai", level: 0 });

    expect(result).toFinishWith(TopicReportWorkflowFinish, { title: "ai", text: "merged" });
    expect(result).toHaveChildExecutions(TopicResearchWorkflow, [
      { item: { title: "ai 1", level: 1 }, finish: TopicReportWorkflowFinish },
      { item: { title: "ai 1 1", level: 2 }, finish: TopicReportWorkflowFinish },
      { item: { title: "robots 1", level: 2 }, finish: TopicFailedWorkflowFinish },
      { item: { title: "robots 1", level: 1 }, finish: TopicFailedWorkflowFinish },
    ]);
    expect(result.children[0]?.children.map((child) => child.depth)).toEqual([3, 3]);
  });
});
