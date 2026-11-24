import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { RecursionDecider } from "../../../src/flow/analyse/recursion.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import type { Class } from "../../../src/components/injection.js";
import { inputLines } from "../../../src/describe/inputs.js";
import { recursionLines } from "../../../src/describe/recursion.js";
import { caseOf, onStart, onWorkflow } from "../../helpers/flow.js";
import {
  ChainWorkflow,
  CountdownAction,
  CountdownWorkflow,
  CountdownWorkflowStart,
  CountDoneDto,
  CountDoneWorkflowFinish,
  CountDto,
  CountStoppedDto,
  CountStoppedWorkflowFinish,
  SplitWorkflow,
  TopicResearchWorkflow,
} from "../runtime/fixtures/recursion.workflow.js";

/**
 * #264 AC2, AC5, AC11, AC12, #1287 — recursion in the analyser: a workflow launches itself with
 * `toWorkflow(() => ItsOwnClass)`, a node of its own name that is the workflow itself; `maxDepth` is required; every recursive branch
 * keeps an exit; mutual recursion is reported; a list of subtopics never fills one topic.
 */

type Flow = WorkflowOptions["flow"];

let count = 0;
/** A recursive workflow of one flow, named uniquely; the flow gets the thunk of its own class. */
function recursive(flowOf: Flow | ((self: () => Class) => Flow), maxDepth?: number): Class {
  count += 1;
  const name = `self-case-${String(count)}-workflow`;
  const flow = typeof flowOf === "function" ? flowOf(() => SelfCaseWorkflow) : flowOf;
  @Workflow(
    maxDepth === undefined
      ? { name, version: "1.0.0", flow }
      : { name, version: "1.0.0", flow, maxDepth },
  )
  class SelfCaseWorkflow {}
  return SelfCaseWorkflow;
}

const codesOf = (target: abstract new () => unknown): readonly string[] =>
  checkWorkflow(target).errors.map((found) => found.code);

const messagesOf = (target: abstract new () => unknown, code: string): readonly string[] =>
  checkWorkflow(target)
    .errors.filter((found) => found.code === code)
    .map((found) => found.message);

/** The countdown's flow: code goes one level deeper while the count lasts. */
const countdown = (self: () => Class): Flow => [
  onStart(CountdownWorkflowStart)
    .toAction(CountdownAction)
    .switch(
      caseOf(CountDto).toWorkflow(self).toFinish(CountDoneWorkflowFinish),
      caseOf(CountDoneDto).toFinish(CountDoneWorkflowFinish),
    ),
];

describe("a workflow launching itself: the workflow itself as a node", () => {
  it("the issue's topic research checks clean: one branch recurses, the researcher's", () => {
    const { analysis, errors, warnings } = checkWorkflow(TopicResearchWorkflow);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(analysis?.graph.nodes.get("topic-research-workflow" as never)?.recursionOf).toBe(
      TopicResearchWorkflow,
    );
    expect(analysis?.recursion).toEqual({
      maxDepth: 3,
      branches: [
        {
          node: "researcher-agent",
          decider: RecursionDecider.Agent,
          options: ["TopicReportDto", "TopicTooBroadDto"],
          recursive: ["TopicTooBroadDto"],
        },
      ],
    });
  });

  it("the child's starts and outputs are the workflow's own", () => {
    const { analysis } = checkWorkflow(CountdownWorkflow);

    expect(analysis?.children.map((found) => found.entry.child.name)).toEqual([
      "countdown-workflow",
    ]);
    expect(analysis?.children[0]?.starts.map((found) => found.name)).toEqual([
      "countdown-workflow-start",
    ]);
  });

  it("a workflow that never launches itself has no recursion", () => {
    expect(checkWorkflow(recursive([], 2)).analysis?.recursion).toBeUndefined();
  });
});

describe("AC2: [graph.recursion-without-depth], mutual recursion", () => {
  it("without maxDepth", () => {
    expect(codesOf(recursive(countdown))).toEqual(["graph.recursion-without-depth"]);
  });

  it("a maxDepth that is not a whole number of levels from 1", () => {
    expect(codesOf(recursive(countdown, 0))).toEqual(["graph.recursion-without-depth"]);
    expect(codesOf(recursive(countdown, 1.5))).toEqual(["graph.recursion-without-depth"]);
    expect(codesOf(recursive(countdown, 1))).toEqual([]);
  });

  it("mutual recursion: A launches B, which launches A", () => {
    const through = (other: abstract new () => unknown): Flow => [
      onStart(CountdownWorkflowStart).toWorkflow(other).toFinish(CountDoneWorkflowFinish),
    ];
    // declared first with no paths, its flow recorded once the other class exists
    @Workflow({ name: "pong-workflow", version: "1.0.0", flow: [] })
    class PongWorkflow {}
    @Workflow({ name: "ping-workflow", version: "1.0.0", flow: through(PongWorkflow) })
    class PingWorkflow {}
    Workflow({ name: "pong-workflow", version: "1.0.0", flow: through(PingWorkflow) })(
      PongWorkflow,
    );

    expect(messagesOf(PingWorkflow, "graph.mutual-recursion")).toEqual([
      "ping-workflow → pong-workflow → ping-workflow: mutual recursion is not supported — a workflow launches only itself (toWorkflow(() => ItsOwnClass)); merge the two into one recursive workflow",
    ]);
  });

  it("a flow naming its own class, as a class or a thunk, is a recursion, not mutual recursion", () => {
    @Workflow({ name: "loop-workflow", version: "1.0.0", flow: [] })
    class LoopWorkflow {}
    const flow: Flow = [
      onStart(CountdownWorkflowStart).toWorkflow(LoopWorkflow).toFinish(CountDoneWorkflowFinish),
    ];
    Workflow({ name: "loop-workflow", version: "1.0.0", flow })(LoopWorkflow);

    expect(codesOf(LoopWorkflow)).toEqual(["graph.recursion-without-depth"]);
    expect(
      codesOf(recursive((self) => [onStart(CountdownWorkflowStart).toWorkflow(self)], 2)),
    ).not.toContain("graph.mutual-recursion");
  });

  it("a class undefined while the flow is built (a circular import)", () => {
    const missing: unknown = undefined;
    const flow: Flow = [
      onStart(CountdownWorkflowStart)
        .toWorkflow(missing as never)
        .toFinish(CountDoneWorkflowFinish),
    ];

    expect(messagesOf(recursive(flow, 2), "graph.mutual-recursion")[0]).toContain(
      "names a class that is undefined while the flow is built — usually a circular import",
    );
  });
});

describe("AC5: [graph.recursion-without-exit]", () => {
  it("every case of a switch launches the workflow itself", () => {
    const flowOf = (self: () => Class): Flow => [
      onStart(CountdownWorkflowStart)
        .toAction(CountdownAction)
        .switch(caseOf(CountDto).toWorkflow(self), caseOf(CountDoneDto).toWorkflow(self)),
      onWorkflow(self).switch(
        caseOf(CountDoneDto).toFinish(CountDoneWorkflowFinish),
        caseOf(CountStoppedDto).toFinish(CountStoppedWorkflowFinish),
      ),
    ];

    expect(messagesOf(recursive(flowOf, 2), "graph.recursion-without-exit")).toEqual([
      expect.stringContaining(
        "countdown-action: every way on (caseOf(CountDoneDto), caseOf(CountDto)) launches the workflow itself",
      ),
    ]);
  });

  it("a branch with an exit, and a launch with no branch at all, pass", () => {
    expect(codesOf(CountdownWorkflow)).toEqual([]);
    expect(codesOf(SplitWorkflow)).toEqual([]);
    expect(codesOf(ChainWorkflow)).toEqual([]);
  });
});

describe("AC11, AC12: what describe prints; a list of subtopics never fills one topic", () => {
  it("recursive: maxDepth, what is left on the last level", () => {
    const lines = (target: abstract new () => unknown) => {
      const { analysis } = checkWorkflow(target);
      return analysis === undefined ? [] : recursionLines(analysis);
    };

    expect(lines(TopicResearchWorkflow)).toEqual([
      "recursive: maxDepth 3, on the last level: researcher-agent → TopicReportDto only",
    ]);
    expect(lines(ChainWorkflow)).toEqual([
      "recursive: maxDepth 2, on the last level: link-router → route(link-agent) only",
    ]);
    expect(lines(CountdownWorkflow)).toEqual([
      "recursive: maxDepth 3, on the last level: countdown-action → CountDto fails (DepthLimitExceededError)",
    ]);
    expect(lines(SplitWorkflow)).toEqual(["recursive: maxDepth 2"]);
  });

  it("each input with its producers: the topic from the start, the results ×0–5", () => {
    const { analysis } = checkWorkflow(TopicResearchWorkflow);

    expect(analysis === undefined ? [] : inputLines(analysis)).toEqual([
      "mark-topic-failed-action ← topic: topic-research-workflow-start",
      "merge-agent ← topic: topic-research-workflow-start, results: topic-research-workflow ×0–5",
      "researcher-agent ← topic: topic-research-workflow-start",
      "subtopics-action ← topic: topic-research-workflow-start, tooBroad: researcher-agent",
    ]);
  });
});
