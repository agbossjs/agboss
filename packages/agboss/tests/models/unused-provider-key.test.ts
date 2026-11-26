/**
 * #716 — a model provider is connected at start (its key read from the driver's `secret(...)` variable)
 * only when it serves a model the workflow uses: an application whose workflows call no model —
 * actions only, no agent, router, guardrail, judge, compaction or reranker — starts with no key at
 * all, while one that does use a model still fails at `createApp`, naming the missing field, before
 * any model call (#266 S73 c).
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { describe, expect, it } from "vitest";
import { Action, Agent, Workflow, WorkflowStart, inline, Ttl } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { Text, WorkflowFinishTextDto } from "../../src/dto/index.js";
import { execute, onStart } from "../helpers/flow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { Reply } from "../testing/fixtures/desk.workflow.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";

class NoteDto {
  @Text({ prompt: "the note" })
  text!: string;
}

@WorkflowStart({ name: "note-workflow-start", description: "A note", input: NoteDto })
class NoteWorkflowStart {}

@Action({
  name: "echo-note-action",
  description: "Echoes the note",
  input: { note: NoteDto },
  output: WorkflowFinishTextDto,
})
class EchoNoteAction {
  execute(input: { readonly note: NoteDto }): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: input.note.text });
  }
}

@Workflow({
  name: "note-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(NoteWorkflowStart).toAction(EchoNoteAction).toFinish(Reply)],
})
class NoteWorkflow {}

@Application({
  name: "model-free-application",
  version: "1.0.0",
  workflows: [NoteWorkflow],
  budgets: TEST_BUDGETS,
})
class ModelFreeApplication {}

@Agent({
  name: "note-writer-agent",
  description: "Writes a reply to the note",
  prompt: inline("Reply to the note."),
  model: "test/writer",
  input: { note: NoteDto },
})
class NoteWriterAgent {}

@Workflow({
  name: "noted-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(NoteWorkflowStart).toAgent(NoteWriterAgent).toFinish(Reply)],
})
class NotedWorkflow {}

@Application({
  name: "model-using-application",
  modelProvider: TestOpenRouterProvider,
  version: "1.0.0",
  workflows: [NotedWorkflow],
  budgets: TEST_BUDGETS,
})
class ModelUsingApplication {}

/** The key is the provider driver's `secret("OPENROUTER_API_KEY")`: no process variable is set. */
const NO_KEYS: NodeJS.ProcessEnv = {};

describe("#716: a provider that serves no model of the application needs no key", () => {
  it("an application whose workflows call no model starts and runs with no OpenRouter key", async () => {
    const app = await createTestAppWith(ModelFreeApplication, { processEnv: NO_KEYS });

    const result = await execute(app, NoteWorkflowStart, { text: "hello" });
    await app.close();

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.output).toEqual({ text: "hello" });
    expect(app.models).toEqual([]);
  });

  it("an application that uses a model still fails at createApp without its key, naming the variable", async () => {
    const started = createTestAppWith(ModelUsingApplication, { processEnv: NO_KEYS });

    await expect(started).rejects.toBeInstanceOf(ConfigError.Environment);
    await expect(started).rejects.toThrow(
      "OPENROUTER_API_KEY is not set (openrouter-model-provider driver.apiKey)",
    );
  });
});
