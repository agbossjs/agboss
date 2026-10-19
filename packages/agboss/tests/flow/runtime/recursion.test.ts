import { beforeEach, describe, expect } from "vitest";
import { replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { TestExecutionBudget } from "../fixtures/budgets.js";
import {
  MergeAgent,
  recursionLog,
  RecursionApplication,
  ResearcherAgent,
  resetRecursionLog,
  TopicReportDto,
  TopicReportWorkflowFinish,
  TopicResearchWorkflow,
  TopicResearchWorkflowStart,
  TopicTooBroadDto,
} from "./fixtures/recursion.workflow.js";
import type { ChildExecutionRecord } from "../../../src/flow/runtime/child-records.js";

/**
 * #264 AC1, AC3, AC7 — a workflow that launches itself (`ThisWorkflow`): topic research three levels
 * deep, each subtopic a child execution of the same workflow, per item; the children's results come
 * back into the parent's path scope and the merge takes them by type after the join.
 */

const test = testWith(RecursionApplication);

const textOf = (request: ModelRequest | undefined): string => {
  const input = request?.input;
  return typeof input === "string" ? input : JSON.stringify(input);
};

/** `ai` → `ml`, `robotics`; `ml` → `deep`, `classic`; every other topic is reported on. */
const SUBTOPICS: Readonly<Record<string, readonly string[]>> = {
  ai: ["ml", "robotics"],
  ml: ["deep", "classic"],
};

const titleIn = (request: ModelRequest): string =>
  /"title": "(\w+)"/.exec(textOf(request))?.[1] ?? "?";

const researcher = (request: ModelRequest) => {
  const title = titleIn(request);
  const subtopics = SUBTOPICS[title];
  return subtopics === undefined
    ? replyWith(TopicReportDto, { title, text: `on ${title}` }, { cost: usd(0.01) })
    : replyWith(TopicTooBroadDto, { subtopics: [...subtopics] }, { cost: usd(0.01) });
};

const merger = (request: ModelRequest) => {
  const title = titleIn(request);
  return replyWith(TopicReportDto, { title, text: `merged ${title}` }, { cost: usd(0.01) });
};

/** Every child of the tree, depth first. */
const everyChild = (children: readonly ChildExecutionRecord[]): readonly ChildExecutionRecord[] =>
  children.flatMap((child) => [child, ...everyChild(child.children)]);

beforeEach(() => {
  resetRecursionLog();
});

describe("AC1: a workflow runs itself as a child", () => {
  test("three levels: each subtopic its own child, merged after the join", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ResearcherAgent).thenAnswer(researcher);
    mockLlm(MergeAgent).thenAnswer(merger);

    const result = await execute(app, TopicResearchWorkflowStart, { title: "ai", level: 0 });

    expect(result).toFinishWith(TopicReportWorkflowFinish, { title: "ai", text: "merged ai" });
    // every child of the tree, depth first: ml's own children inside it
    expect(result).toHaveChildExecutions(TopicResearchWorkflow, [
      { item: { title: "ml", level: 1 }, finish: TopicReportWorkflowFinish },
      { item: { title: "deep", level: 2 }, finish: TopicReportWorkflowFinish },
      { item: { title: "classic", level: 2 }, finish: TopicReportWorkflowFinish },
      { item: { title: "robotics", level: 1 }, finish: TopicReportWorkflowFinish },
    ]);
    expect(result.children.map((child) => child.input)).toEqual([
      { title: "ml", level: 1 },
      { title: "robotics", level: 1 },
    ]);
    const merged = mockLlm(MergeAgent).requests.map(titleIn);
    expect([...merged].sort()).toEqual(["ai", "ml"]);
    expect(textOf(mockLlm(MergeAgent).requests.at(-1))).toContain("merged ml");
  });
});

describe("AC3: depth 1 … maxDepth in the context and the record", () => {
  test("the root is 1, its children 2, theirs 3", async ({ app, mockLlm }) => {
    mockLlm(ResearcherAgent).thenAnswer(researcher);
    mockLlm(MergeAgent).thenAnswer(merger);

    const result = await execute(app, TopicResearchWorkflowStart, { title: "ai", level: 0 });

    const depths = recursionLog.readings.map(({ title, depth, level }) => ({
      title,
      depth,
      level,
    }));
    expect(depths).toEqual([
      { title: "ai", depth: 1, level: 0 },
      { title: "ml", depth: 2, level: 1 },
    ]);
    const records = everyChild(result.children).map((child) => [child.input, child.depth]);
    expect(records).toEqual([
      [{ title: "ml", level: 1 }, 2],
      [{ title: "deep", level: 2 }, 3],
      [{ title: "classic", level: 2 }, 3],
      [{ title: "robotics", level: 1 }, 2],
    ]);
  });
});

describe("AC7: the root's budget counts every level; each execution its own maxSteps", () => {
  test("seven model calls of five executions, all in the root's spend", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(TestExecutionBudget).maxSpend.mockReturnValue(usd(1));
    mockLlm(ResearcherAgent).thenAnswer(researcher);
    mockLlm(MergeAgent).thenAnswer(merger);

    const result = await execute(app, TopicResearchWorkflowStart, { title: "ai", level: 0 });

    // 5 researchers + 2 merges, each $0.01: the root's spend holds every level
    expect(result.spend.totalUsd).toBeCloseTo(0.07, 6);
    const ownSpend = everyChild(result.children).map((child) => child.spend.totalUsd);
    expect(ownSpend.map((spent) => Number(spent.toFixed(2)))).toEqual([0.04, 0.01, 0.01, 0.01]);
    // maxSteps 4 holds for each execution: ml took 2 agent steps of its own, the tree 7
    const ml = result.children[0];
    expect(ml?.path.filter((node) => node.endsWith("-agent"))).toEqual([
      "researcher-agent",
      "merge-agent",
    ]);
  });
});
