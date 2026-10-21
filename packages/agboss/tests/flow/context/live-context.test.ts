import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/application/create-app.js";
import type { App } from "../../../src/app/types.js";
import { ExecutionContext, ExecutionContextUnavailableError } from "../../../src/index.js";
import { createSqliteTernStore } from "../../../src/terns/index.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import {
  callTool,
  replyWith,
  routeTo,
  testWith,
  type WorkflowFixtures,
} from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ContextStart,
  ContextWorkflow,
  DraftDto,
  EagerAuditApplication,
  LazyAuditService,
  NoteTool,
  PublishAction,
  ReviewRouter,
  WriterAgent,
  resetSeen,
  seen,
  AuditApplication,
  ContextApplication,
} from "./fixtures/context.workflow.js";

const test = testWith(ContextApplication);

/** The audit workflow's app, nothing running: its services are created at start, outside any execution. */
const auditApp = (): Promise<App> =>
  createApp(AuditApplication, {
    processEnv: {},
    gateway: createScriptedGateway(new ScriptBook()),
  });

/** The context a service got, read outside any execution. */
const lazyContext = async (): Promise<ExecutionContext> =>
  (await auditApp()).resolve(LazyAuditService).executionContext;

beforeEach(resetSeen);

/** The writer notes once and answers; the review publishes. */
const oneDraft = (mockLlm: WorkflowFixtures["mockLlm"]): void => {
  mockLlm(WriterAgent).thenReturn(
    callTool(NoteTool, { text: "intro" }),
    replyWith(DraftDto, { text: "v1" }),
  );
  mockLlm(ReviewRouter).thenReturn(routeTo(PublishAction));
};

describe("#280 AC6, AC12: the injected ExecutionContext gives the current execution", () => {
  test("injected: a tool and an action read their execution and their own step", async ({
    app,
    mockLlm,
  }) => {
    oneDraft(mockLlm);

    const done = await execute(app, ContextStart, { text: "a post" }, { ownerId: "dana" });

    const [tool] = seen.toolSteps;
    const [action] = seen.actionSteps;
    expect(tool).toMatchObject({
      component: { type: WriterAgent, name: "writer-agent" },
      nodeId: "writer-agent",
      visitNumber: 1,
      copyNumber: 1,
      itemIndex: undefined,
    });
    expect(tool?.callId).toEqual(expect.any(String));
    expect(action).toEqual({
      component: { type: PublishAction, name: "publish-action" },
      nodeId: "publish-action",
      visitNumber: 1,
      idempotencyKey: `${done.executionId}:publish-action:1`,
      callId: undefined,
      itemIndex: undefined,
      copyNumber: 1,
    });
  });

  test("one-level tree before #263: no parent, root is itself, depth 1, executionOf(W)", async ({
    app,
    mockLlm,
  }) => {
    oneDraft(mockLlm);

    const done = await execute(app, ContextStart, { text: "a post" });

    expect(seen.tree).toEqual([{ parent: undefined, rootIsSelf: true, depth: 1 }]);
    expect(seen.executionOf).toEqual([done.executionId, undefined]);
  });

  test("the workflow descriptor names the class, its name and both versions", async ({
    app,
    mockLlm,
  }) => {
    oneDraft(mockLlm);

    await execute(app, ContextStart, { text: "a post" });

    expect(seen.workflows).toEqual([
      {
        type: ContextWorkflow,
        name: "context-workflow",
        version: "2.1.0",
        startedVersion: "2.1.0",
      },
    ]);
  });
});

describe("#280: a tool called on its own runs in an execution of its own", () => {
  test("app.tool(T).invoke: one step, the tool's name as its node id", async ({ app }) => {
    const result = await app.tool(NoteTool).invoke({ text: "alone" });

    expect(result).toEqual({ kind: "ok", value: { text: "alone" } });
    expect(seen.toolSteps).toEqual([
      {
        component: { type: NoteTool, name: "note-tool" },
        nodeId: "note-tool",
        visitNumber: 1,
        idempotencyKey: "tool-slice:note-tool:1:tool-slice",
        callId: "tool-slice",
        itemIndex: undefined,
        copyNumber: 1,
      },
    ]);
  });
});

describe("#280 AC7, AC12: outside an execution a read throws, never undefined", () => {
  it("outside an execution throws: a constructor reading it at start names its class", async () => {
    // every listed provider is created at start (#261): the application does not start
    const start = createApp(EagerAuditApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });

    await expect(start).rejects.toThrow(ExecutionContextUnavailableError);
    await expect(start).rejects.toThrow(
      "EagerAuditService read executionContext.executionId outside an execution",
    );
  });

  it("injecting it is allowed; only the read fails, with code context.unavailable", async () => {
    const executionContext = await lazyContext();

    const read = (): unknown => executionContext.step;

    expect(executionContext).toBeInstanceOf(ExecutionContext);
    expect(read).toThrow(expect.objectContaining({ code: "context.unavailable" }) as Error);
  });
});

describe("#280 AC8 (S18): data only, read-only, closed with its step", () => {
  it("read-only: nothing is set through it", async () => {
    const executionContext = await lazyContext();

    const write = (): void => {
      Object.assign(executionContext, { executionId: "forged" });
    };

    expect(write).toThrow(TypeError);
    expect(Object.isFrozen(executionContext)).toBe(true);
  });

  it("no metadata: the context has no string-keyed map (AC10)", async () => {
    const executionContext = await lazyContext();

    expect("metadata" in executionContext).toBe(false);
    expect("input" in executionContext).toBe(false);
  });

  test("after step ended throws: a stray promise of a tool names the ended tool call", async ({
    app,
    mockLlm,
  }) => {
    oneDraft(mockLlm);

    const done = await execute(app, ContextStart, { text: "a post" });
    const [stray] = await Promise.all(seen.strays);

    expect(stray).toBeInstanceOf(ExecutionContextUnavailableError);
    expect((stray as Error).message).toContain(
      `the execution context was read after its step ended (writer-agent:1 tool call ${String(seen.toolSteps[0]?.callId)} in execution ${done.executionId})`,
    );
  });

  test("tool frame closes before the agent's: the stray read never falls back to the agent", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(WriterAgent).thenReturn(
      callTool(NoteTool, { text: "intro" }),
      callTool(NoteTool, { text: "outro" }),
      replyWith(DraftDto, { text: "v1" }),
    );
    mockLlm(ReviewRouter).thenReturn(routeTo(PublishAction));

    await execute(app, ContextStart, { text: "a post" });
    const strays = await Promise.all(seen.strays);

    expect(strays).toHaveLength(2);
    for (const stray of strays) expect(stray).toBeInstanceOf(ExecutionContextUnavailableError);
    expect(seen.toolSteps.map((step) => step.callId)).toHaveLength(2);
  });
});
