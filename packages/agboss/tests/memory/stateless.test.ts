/**
 * #1303b (D8): a workflow with no `memory` is stateless — its agents read no earlier turn of a thread
 * — and reusing a thread of such a workflow is warned about (`memory.thread-reuse-without-memory`).
 */
import { describe, expect } from "vitest";
import {
  Agent,
  Application,
  EmptyEnvironment,
  Injectable,
  Logger,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type LogEntry,
  inline,
  Ttl,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, onStart } from "../helpers/flow.js";
import { Window2Memory } from "../helpers/window-memory.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const entries: LogEntry[] = [];

@Injectable()
class CollectingLogger extends Logger {
  write(entry: LogEntry): void {
    entries.push(entry);
  }
}

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
class ChatStart {}

@WorkflowFinish({
  name: "chat-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
class ChatFinish {}

@Agent({
  name: "chat-agent",
  description: "Answers",
  prompt: inline("Answer."),
  model: "test/chat",
})
class ChatAgent {}

@Workflow({
  name: "stateless-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart).toAgent(ChatAgent).toFinish(ChatFinish)],
})
class StatelessWorkflow {}

@Workflow({
  name: "remembering-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart).toAgent(ChatAgent).toFinish(ChatFinish)],
  memory: Window2Memory,
})
class RememberingWorkflow {}

const applicationOf = (workflow: typeof StatelessWorkflow, name: string) => {
  @Application({
    name,
    modelProvider: TestModelProvider,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [workflow],
    providers: [CollectingLogger],
    budgets: TEST_BUDGETS,
  })
  class StatelessTestApplication {}
  return StatelessTestApplication;
};

describe("#1303b: a workflow without memory is stateless", () => {
  const test = testWith(applicationOf(StatelessWorkflow, "stateless-application"));

  test("the agent reads no earlier turn, and reusing the thread is warned about", async ({
    app,
    mockModel,
  }) => {
    entries.length = 0;
    mockModel(ChatAgent).thenReturnAlways(replyWith("ok"));
    const first = await execute(app, ChatStart, { text: "t1" });

    await execute(app, ChatStart, { text: "t2" }, { threadId: first.threadId });

    const request = mockModel(ChatAgent).lastRequest;
    const text = request.kind === "chat" ? JSON.stringify(request.messages) : "";
    expect(text).not.toContain("t1");
    const warned = entries.filter((entry) => entry.code === "memory.thread-reuse-without-memory");
    expect(new Set(warned.map((entry) => entry.executionId)).size).toBe(1);
    expect(warned[0]).toMatchObject({ level: "warn", tenantId: "default" });
  });
});

describe("#1303b: a workflow with memory is not warned", () => {
  const test = testWith(applicationOf(RememberingWorkflow, "remembering-application"));

  test("the agent reads the earlier turn", async ({ app, mockModel }) => {
    entries.length = 0;
    mockModel(ChatAgent).thenReturnAlways(replyWith("ok"));
    const first = await execute(app, ChatStart, { text: "t1" });

    await execute(app, ChatStart, { text: "t2" }, { threadId: first.threadId });

    const request = mockModel(ChatAgent).lastRequest;
    const text = request.kind === "chat" ? JSON.stringify(request.messages) : "";
    expect(text).toContain("t1");
    expect(entries.filter((entry) => entry.code === "memory.thread-reuse-without-memory")).toEqual(
      [],
    );
  });
});
