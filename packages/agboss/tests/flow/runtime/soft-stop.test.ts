import { beforeEach, describe, expect } from "vitest";
import {
  ChildExecutionFailedError,
  RouterDecisionError,
  ThisWorkflow,
} from "../../../src/index.js";
import { replyWith, routeTo, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ChainDoneWorkflowFinish,
  ChainWorkflowStart,
  CodeChainWorkflowStart,
  LinkAgent,
  LinkDoneDto,
  LinkRouter,
  MergeAgent,
  RecursionApplication,
  ResearcherAgent,
  resetRecursionLog,
  TopicReportDto,
  TopicReportWorkflowFinish,
  TopicTooBroadDto,
  TopicResearchWorkflowStart,
} from "./fixtures/recursion.workflow.js";

/**
 * #264 AC4 — the soft stop: on the last level (`depth === maxDepth`) a choice that launches
 * `ThisWorkflow` is not offered. The researcher's `TopicTooBroadDto` leaves its response schema
 * (its answer tool is not bound), a model router's model does not see its recursive route, a code
 * router that returns it fails with `RouterDecisionError`.
 */

const test = testWith(RecursionApplication);

const textOf = (request: ModelRequest): string =>
  typeof request.input === "string" ? request.input : JSON.stringify(request.input);

const toolsOf = (request: ModelRequest | undefined): readonly string[] =>
  request?.kind === "chat" ? request.tools.map((tool) => tool.function.name).sort() : [];

const optionsOf = (request: ModelRequest | undefined): readonly string[] =>
  request?.kind === "decision" ? [...request.options].sort() : [];

/** Every topic but the last level's is too broad: one subtopic deeper. */
const deeper = (request: ModelRequest) => {
  const title = /"title": "(\w+)"/.exec(textOf(request))?.[1] ?? "?";
  const level = Number(/"level": (\d+)/.exec(textOf(request))?.[1] ?? "0");
  return request.kind === "chat" && toolsOf(request).includes("answer-topic-too-broad-dto")
    ? replyWith(TopicTooBroadDto, { subtopics: [`${title}${String(level + 1)}`] })
    : replyWith(TopicReportDto, { title, text: `on ${title}` });
};

beforeEach(() => {
  resetRecursionLog();
});

describe("AC4: an agent's recursive variant leaves its schema on the last level", () => {
  test("levels 1 and 2 may answer TopicTooBroadDto, level 3 only TopicReportDto", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ResearcherAgent).thenAnswer(deeper);
    mockLlm(MergeAgent).thenAnswer((request) =>
      replyWith(TopicReportDto, { title: "merged", text: textOf(request).slice(0, 10) }),
    );

    const result = await execute(app, TopicResearchWorkflowStart, { title: "t", level: 0 });

    expect(result).toFinishWith(TopicReportWorkflowFinish, expect.anything());
    const asked = mockLlm(ResearcherAgent).requests.map(toolsOf);
    expect(asked).toEqual([
      ["answer-topic-report-dto", "answer-topic-too-broad-dto"],
      ["answer-topic-report-dto", "answer-topic-too-broad-dto"],
      ["answer-topic-report-dto"],
    ]);
    expect(result.children[0]?.children[0]?.depth).toBe(3);
  });
});

describe("AC4: a model router does not see a recursive route on the last level", () => {
  test("depth 1 sees both routes; at depth 2 (maxDepth) only the exit is left", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(LinkRouter).thenReturn(routeTo(ThisWorkflow));
    mockLlm(LinkAgent).thenReturn(replyWith(LinkDoneDto, { name: "end" }));

    const result = await execute(app, ChainWorkflowStart, { name: "a" });

    expect(result).toFinishWith(ChainDoneWorkflowFinish, { name: "end" });
    // one model call: on the last level the one route left needs no model (a single option)
    expect(mockLlm(LinkRouter).requests.map(optionsOf)).toEqual([["link-agent", "this-workflow"]]);
    expect(result.children.map((child) => [child.depth, child.path])).toEqual([
      [2, ["chain-workflow-start", "link-router", "link-agent", "chain-done-workflow-finish"]],
    ]);
  });
});

describe("AC4: a code router returning a recursive route on the last level", () => {
  test("fails with RouterDecisionError: the route is not ready", async ({ app }) => {
    const run = execute(app, CodeChainWorkflowStart, { name: "a" });

    // the child at depth 2 (maxDepth) fails its step; the root sees the child's failure
    await expect(run).rejects.toFailWith(ChildExecutionFailedError, { cause: RouterDecisionError });
    await expect(execute(app, CodeChainWorkflowStart, { name: "b" })).rejects.toFailWith(
      RouterDecisionError,
      { message: expect.stringContaining("is not ready") },
    );
  });
});
