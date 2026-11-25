import { beforeEach, describe, expect, it } from "vitest";
import {
  Observer,
  AgentRetryReason,
  nameOf,
  type AgentRetryEvent,
  type ExecutionEndEvent,
  type ToolEndEvent,
  type ToolStartEvent,
} from "../../../src/index.js";
import {
  callTool,
  callToolWithInvalidArguments,
  callToolWithTruncatedArguments,
  replyWith,
  testWith,
} from "../../../src/testing/index.js";
import { createTestAppWith } from "../../../src/testing/create-app-with.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { ComponentError } from "../../../src/index.js";
import { observerOf } from "../../../src/core/observer-hooks.js";
import { EchoTool, Start, Worker, applicationWith, workflowWith } from "./fixture.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import {
  ClerkAgent,
  ClerkStart,
  ClerkWorkflow,
  LookupOrderTool,
} from "../../app/fixtures/trajectory.workflow.js";
import { execute } from "../../helpers/flow.js";
import { auditCalls } from "./fixture.js";
import { LocalModelProvider } from "../../models/providers.fixture.js";

const ends: string[] = [];
const retries: AgentRetryEvent[] = [];

beforeEach(() => {
  ends.length = 0;
  retries.length = 0;
  auditCalls.length = 0;
});

const ObservedWorkflow = workflowWith("observed-workflow");
const OtherWorkflow = workflowWith("other-workflow");

/** No filter: every execution's end. */
@Observer()
class EveryEnd {
  onExecutionEnd(event: ExecutionEndEvent): void {
    ends.push(`every:${event.workflow.name}`);
  }
}

/** Only the named workflow's events. */
@Observer({ workflows: [ObservedWorkflow] })
class OneWorkflowEnd {
  onExecutionEnd(event: ExecutionEndEvent): void {
    ends.push(`one:${event.workflow.name}`);
  }
}

/** Only a workflow the application does not run. */
@Observer({ workflows: [OtherWorkflow] })
class ElsewhereEnd {
  onExecutionEnd(event: ExecutionEndEvent): void {
    ends.push(`elsewhere:${event.workflow.name}`);
  }
}

/** Only the worker agent's events: its tool calls, with the agent's name flat on them. */
@Observer({ agents: [Worker] })
class WorkerOnly {
  onToolStart(event: ToolStartEvent): void {
    ends.push(`tool-start:${event.agent ?? "none"}:${event.tool}`);
  }
  onToolEnd(event: ToolEndEvent): void {
    ends.push(`tool-end:${event.agent ?? "none"}:${event.output}`);
  }
  onExecutionEnd(): void {
    ends.push("worker-only:execution-end");
  }
}

/** Retries of any agent. */
@Observer({ name: "retry-watch" })
class RetryWatch {
  onAgentRetry(event: AgentRetryEvent): void {
    retries.push(event);
  }
}

const filtered = testWith(
  applicationWith("observed-workflow", [
    EveryEnd,
    OneWorkflowEnd,
    ElsewhereEnd,
    WorkerOnly,
    RetryWatch,
  ]),
);

describe("@Observer workflows / agents filters", () => {
  filtered("deliver only the matching workflow's and agent's events", async ({ app, mockLlm }) => {
    mockLlm(Worker).thenReturn(callTool(EchoTool, { text: "hi" }), replyWith("done"));

    await execute(app, Start, { text: "hello" });

    expect(ends).toEqual([
      "tool-start:worker-agent:echo-tool",
      'tool-end:worker-agent:{"text":"echo hi"}',
      "every:observed-workflow",
      "one:observed-workflow",
    ]);
  });
});

@Application({
  name: "retry-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClerkWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
  observers: [RetryWatch],
})
class RetryApplication {}

const retrying = testWith(RetryApplication);

describe("@Observer onAgentRetry", () => {
  retrying("tells an agent's tool-input retries", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(
      callToolWithInvalidArguments(LookupOrderTool, { orderId: 7 }),
      callToolWithTruncatedArguments(LookupOrderTool, { orderId: "7" }),
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Order 7 has shipped."),
    );

    await execute(app, ClerkStart, { text: "where is 7?" });

    expect(retries.map((retry) => [retry.agent, retry.reason, retry.attempt])).toEqual([
      ["clerk-agent", AgentRetryReason.InvalidToolInput, 1],
      ["clerk-agent", AgentRetryReason.InvalidToolInput, 2],
    ]);
    expect(retries[0]?.maxAttempts).toBeGreaterThan(2);
    expect(retries[0]?.feedback).not.toBe("");
  });
});

describe("@Observer onAgentRetry after a judge", () => {
  retrying("tells a rejected reply that is retried", async ({ app, mockLlm }) => {
    mockLlm(ClerkAgent).thenReturn(
      replyWith("It has shipped."),
      callTool(LookupOrderTool, { orderId: "7" }),
      replyWith("Order 7 has shipped."),
    );

    await execute(app, ClerkStart, { text: "where is 7?" });

    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      agent: "clerk-agent",
      reason: AgentRetryReason.JudgeRejected,
      attempt: 1,
      maxAttempts: 2,
    });
    expect(retries[0]?.feedback).toContain("Look the order up first.");
  });
});

describe("@Observer records its options", () => {
  it("names the observer after its class, kebab-case, unless it is named", () => {
    expect(observerOf(EveryEnd)?.name).toBe("every-end");
    expect(nameOf(RetryWatch)).toBe("retry-watch");
    expect(observerOf(OneWorkflowEnd)?.workflows).toEqual([ObservedWorkflow]);
    expect(observerOf(WorkerOnly)?.agents).toEqual([Worker]);
  });
});

const assemblyError = (observers: Parameters<typeof applicationWith>[1]): Promise<string> =>
  createTestAppWith(applicationWith("observed-workflow", observers), {
    gateway: createScriptedGateway(new ScriptBook()),
    processEnv: {},
  }).then(
    async (app) => {
      await app.close();
      return "assembled";
    },
    (error: unknown) => (error instanceof ComponentError ? error.message : String(error)),
  );

/** A class with a hook but no decorator. */
class Undecorated {
  onExecutionEnd(): void {
    /* a real hook */
  }
}

@Observer({ name: "same-name" })
class FirstSame {
  onExecutionEnd(): void {
    /* a real hook */
  }
}

@Observer({ name: "same-name" })
class SecondSame {
  onExecutionEnd(): void {
    /* a real hook */
  }
}

@Observer({ name: "Not_Kebab" })
class BadName {
  onExecutionEnd(): void {
    /* a real hook */
  }
}

describe("@Application observers are @Observer classes", () => {
  it("rejects a listed class without @Observer", async () => {
    expect(await assemblyError([Undecorated])).toBe(
      "[observer.not-an-observer] Undecorated is listed in @Application observers but has no @Observer decorator",
    );
  });

  it("rejects two observers with one name", async () => {
    expect(await assemblyError([FirstSame, SecondSame])).toContain("[observer.duplicate-name]");
  });

  it("rejects a name that is not kebab-case", async () => {
    expect(await assemblyError([BadName])).toContain("[name.not-kebab-case]");
  });
});
