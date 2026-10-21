/**
 * #261 PR 6 — observer events: one event object per hook with the common fields of the execution
 * (`ExecutionEvent`), node events with their `step` (`StepRecord`), plain data — never the
 * framework's internal state; `onExecutionRejected` names the refused operation (#269).
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ComponentError,
  ComponentKind,
  ExecutionOperation,
  InvalidThreadIdError,
  nameOf,
  UnknownThreadError,
  Workflow,
} from "../../../src/index.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { execute, answerOf } from "../../helpers/flow.js";
import {
  AnswerDto,
  Apply,
  Applications,
  ApplicationsApplication,
  Ask,
  Clerk,
  executionEvents,
  Lookup,
  nodeEvents,
  RunLog,
  rejections,
  resetEvents,
} from "../../app/fixtures/run-events.workflow.js";

const test = testWith(ApplicationsApplication);
const approve = { approved: true };

beforeEach(resetEvents);

describe("#261 AC7, AC15: every event carries the execution's common fields", () => {
  test("start, pause, resume and end name the execution, its root, thread, tenant and WorkflowRecord", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(AnswerDto, { text: "Applied." }),
    );

    const paused = await execute(app, Ask, { text: "apply" }, { tenant: { tenantId: "acme" } });
    await app.resume(answerOf(paused, approve), { tenantId: "acme" });

    expect(executionEvents).toHaveLength(4);
    for (const event of executionEvents) {
      expect(event).toMatchObject({
        executionId: paused.executionId,
        parentExecutionId: undefined,
        rootExecutionId: paused.executionId,
        threadId: paused.threadId,
        tenantId: "acme",
        workflow: { name: "applications-workflow", version: "1.0.0", startedVersion: "1.0.0" },
      });
    }
  });

  test("a WorkflowRecord is plain data: no class, the same after a JSON round trip", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "One." }));

    await execute(app, Ask, { text: "one" });

    for (const event of [...executionEvents, ...nodeEvents]) {
      expect(event.workflow).not.toHaveProperty("type");
      expect(JSON.parse(JSON.stringify(event.workflow))).toEqual(event.workflow);
    }
  });

  test("no event carries the internal state", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Lookup, { text: "rust" }),
      replyWith(AnswerDto, { text: "2 jobs." }),
    );

    await execute(app, Ask, { text: "look" });

    for (const event of [...executionEvents, ...nodeEvents]) {
      expect(event).not.toHaveProperty("state");
    }
  });

  test("onExecutionEnd gives the finish as a ComponentRecord and the spend", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "One." }));

    const done = await execute(app, Ask, { text: "one" });

    expect(executionEvents.at(-1)).toMatchObject({
      finish: { name: "done-workflow-finish" },
      spend: done.spend,
    });
  });
});

describe("#261 AC15: node events carry their step (StepRecord)", () => {
  test("agent, model, tool and action events name the step by component name, node, visit and key", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Lookup, { text: "rust" }),
      replyWith(AnswerDto, { text: "2 jobs." }),
    );

    const done = await execute(app, Ask, { text: "look" });

    const [agentStart] = nodeEvents;
    expect(agentStart?.step).toEqual({
      component: {
        name: "clerk-agent",
        kind: ComponentKind.Agent,
        promptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      nodeId: "clerk-agent",
      visitNumber: 1,
      copyNumber: 1,
      itemIndex: undefined,
      idempotencyKey: `${done.executionId}:clerk-agent:1`,
      callId: undefined,
      toolLoopIteration: undefined,
      validationAttempts: 0,
    });
    const action = nodeEvents.at(-1);
    expect(action?.step).toMatchObject({
      component: { name: "file-action" },
      nodeId: "file-action",
    });
    for (const event of nodeEvents) {
      expect(event.step.component).not.toHaveProperty("type");
      expect(event).toMatchObject({ executionId: done.executionId, tenantId: "default" });
    }
  });
});

describe("#269: onExecutionRejected names the refused operation (ExecutionOperation)", () => {
  test("execute, resume and cancel refusals carry their operation and the tenant", async ({
    app,
  }) => {
    await expect(app.cancel("no-such-thread", { tenantId: "acme" })).rejects.toBeInstanceOf(
      UnknownThreadError,
    );
    await expect(app.resume({ pauseId: "no-such-pause", decision: approve })).rejects.toThrow();
    // an unknown id is the caller's own new thread (#262 Q4): an invalid one is refused
    await expect(
      execute(app, Ask, { text: "x" }, { threadId: "no\nthread" }),
    ).rejects.toBeInstanceOf(InvalidThreadIdError);

    expect(rejections.map(({ operation, tenantId }) => ({ operation, tenantId }))).toEqual([
      { operation: ExecutionOperation.Cancel, tenantId: "acme" },
      { operation: ExecutionOperation.Resume, tenantId: "default" },
      { operation: ExecutionOperation.Execute, tenantId: "default" },
    ]);
    expect(rejections.every((event) => !("executionId" in event))).toBe(true);
  });
});

describe("#261 AC15: observers are registered only in @Application", () => {
  test("@Workflow takes no observers", () => {
    const declare = (): unknown =>
      Workflow({
        name: "unobserved-workflow",
        version: "1.0.0",
        flow: [],
        // @ts-expect-error — observers belong to @Application({ observers })
        observers: [RunLog],
      });

    expect(declare).not.toThrow();
  });
});

describe("#261 AC7: nameOf(C) — the name of any AGBoss-decorated class", () => {
  test("serialized events are filtered by the names of the classes", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(replyWith(AnswerDto, { text: "One." }));

    await execute(app, Ask, { text: "one" });

    expect(executionEvents.every((event) => event.workflow.name === nameOf(Applications))).toBe(
      true,
    );
    expect(nodeEvents[0]?.step.component.name).toBe(nameOf(Clerk));
    expect([nameOf(Ask), nameOf(ApplicationsApplication), nameOf(Lookup)]).toEqual([
      "ask-workflow-start",
      "applications-application",
      "lookup-tool",
    ]);
  });

  test("a class no AGBoss decorator describes throws", () => {
    class Plain {
      readonly kind = "plain";
    }

    expect(() => nameOf(Plain)).toThrow(ComponentError);
  });
});
