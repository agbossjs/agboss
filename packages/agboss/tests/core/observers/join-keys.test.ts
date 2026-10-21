/**
 * #268 S92 / S93 — join keys: every execution event's `WorkflowRecord` carries the workflow's
 * `configHash`, every step's `ComponentRecord` its kind, `promptHash` and `schemaHash`, and a step of
 * an agent's loop its `toolLoopIteration` and `validationAttempts` — the same values the declarative
 * snapshot (`agboss describe --json`) gives, so a trace joins the static schema.
 */
import { beforeEach, describe, expect } from "vitest";
import { applicationOf } from "../../../src/application/assemble.js";
import { describeServices } from "../../../src/describe/describe-workflow.js";
import { workflowSnapshotOf, type WorkflowSnapshot } from "../../../src/describe/snapshot.js";
import { ComponentKind } from "../../../src/index.js";
import { callTool, replyWith, testWith, type ToolCallTurn } from "../../../src/testing/index.js";
import { answerOf, execute } from "../../helpers/flow.js";
import {
  AnswerDto,
  Apply,
  ApplicationsApplication,
  Ask,
  Clerk,
  executionEvents,
  Lookup,
  nodeEvents,
  resetEvents,
} from "../../app/fixtures/run-events.workflow.js";

const test = testWith(ApplicationsApplication);

beforeEach(resetEvents);

const assembled = await applicationOf(ApplicationsApplication);
const [applications] = assembled.workflows;
if (applications === undefined) throw new TypeError("the fixture lists one workflow");
const snapshot: WorkflowSnapshot = workflowSnapshotOf(applications, describeServices);
const clerkNode = snapshot.nodes.find((node) => node.name === "clerk-agent");

/** A tool call the tool's input refuses: `text` is required. */
const invalidLookup: ToolCallTurn = { kind: "tool-call", tool: "lookup-tool", args: {} };

describe("#268 S93: configHash is the one key of the workflow", () => {
  test("every execution and node event carries the configHash describe --json gives", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "Done." }));

    await execute(app, Ask, { text: "one" });

    expect(executionEvents.length).toBeGreaterThan(0);
    for (const event of [...executionEvents, ...nodeEvents])
      expect(event.workflow.configHash).toBe(snapshot.configHash);
    expect(snapshot.configHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("#268 S93: a step's ComponentRecord carries its kind and hashes", () => {
  test("an agent's step is named by its kind, promptHash and schemaHash, as in the snapshot", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "Done." }));

    await execute(app, Ask, { text: "one" });

    const agentStep = nodeEvents.find((event) => event.step.component.name === "clerk-agent");
    expect(agentStep?.step.component).toEqual({
      name: "clerk-agent",
      kind: ComponentKind.Agent,
      promptHash: clerkNode?.promptHash,
      schemaHash: clerkNode?.schemaHash,
    });
    expect(clerkNode?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(clerkNode?.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an action's step has a schema but no prompt; the finish of the result is a full record", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "Done." }));

    const result = await execute(app, Ask, { text: "one" });

    const actionStep = nodeEvents.find((event) => event.step.component.name === "file-action");
    expect(actionStep?.step.component).toMatchObject({
      kind: ComponentKind.Action,
      promptHash: undefined,
    });
    const done = snapshot.nodes.find((node) => node.name === "done-workflow-finish");
    expect(result.finish).toEqual({
      name: "done-workflow-finish",
      kind: ComponentKind.WorkflowFinish,
      promptHash: undefined,
      schemaHash: done?.schemaHash,
    });
  });
});

describe("#268 S93: StepRecord + toolLoopIteration and validationAttempts", () => {
  test("a model call and the tool calls of its move name the loop's iteration", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Lookup, { text: "rust" }),
      replyWith(AnswerDto, { text: "2 jobs." }),
    );

    await execute(app, Ask, { text: "find" });

    const iterations = nodeEvents.map((event) => event.step.toolLoopIteration);
    const agentStart = nodeEvents.find((event) => event.step.toolLoopIteration === undefined);
    expect(agentStart?.step.component.name).toBe("clerk-agent");
    expect(iterations.filter((iteration) => iteration !== undefined)).toEqual([1, 1, 2]);
    expect(nodeEvents.every((event) => event.step.validationAttempts === 0)).toBe(true);
  });

  test("a tool call whose arguments fail the tool's input counts one validation attempt", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      invalidLookup, // the tool refuses its arguments; the model tries again

      callTool(Lookup, { text: "rust" }),
      replyWith(AnswerDto, { text: "2 jobs." }),
    );

    await execute(app, Ask, { text: "find" });

    const inLoop = nodeEvents.filter((event) => event.step.toolLoopIteration !== undefined);
    expect(
      inLoop.map((event) => [event.step.toolLoopIteration, event.step.validationAttempts]),
    ).toEqual([
      [1, 0],
      [1, 0],
      [2, 1],
      [2, 1],
      [3, 1],
    ]);
  });

  test("a pause keeps its step's join keys: the answer record names the iteration that asked", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Lookup, { text: "rust" }),
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );

    const paused = await execute(app, Ask, { text: "apply" });
    const done = await app.resume(answerOf(paused, { approved: true }), { record: true });

    expect(done.record?.pauses).toMatchObject([
      {
        step: {
          component: {
            name: "clerk-agent",
            kind: ComponentKind.Agent,
            promptHash: clerkNode?.promptHash,
            schemaHash: clerkNode?.schemaHash,
          },
          toolLoopIteration: 2,
          validationAttempts: 0,
        },
      },
    ]);
  });

  test("a StepRecord stays plain data", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "One." }));

    await execute(app, Ask, { text: "one" });

    for (const { step } of nodeEvents) {
      expect(step.component).not.toHaveProperty("type");
      expect(JSON.parse(JSON.stringify({ ...step, toolLoopIteration: null }))).toMatchObject({
        component: { name: step.component.name, kind: step.component.kind },
      });
    }
  });
});
