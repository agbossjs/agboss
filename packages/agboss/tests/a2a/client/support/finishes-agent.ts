// #916 item 3 — an AGBoss-looking agent whose card lists two finishes of one schema, and whose task
// ends at the finish the test names (its artifact's metadata[skills-uri].finish).
import { AgentEvent } from "@a2a-js/sdk/server";
import { A2A_SKILLS_EXTENSION } from "../../../../src/a2a/a2a-extension-uris.js";
import { Text } from "../../../../src/dto/index.js";
import { hours } from "../../../../src/units/index.js";
import { dataPart, SdkAgent, taskOf, TaskState } from "./sdk-agent.js";

/** What both finishes of the agent's skill give. */
export class AnswerDto {
  @Text({ prompt: "the answer" })
  text!: string;
}

const SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

/** The agent: skill `ask-workflow-start`, finishes `answer-…` and `hand-over-workflow-finish`. */
export function agentEndingAt(finish: string): SdkAgent {
  return new SdkAgent({
    agboss: {
      idempotencyRetention: hours(24),
      skills: {
        "ask-workflow-start": {
          input: null,
          outputs: { "answer-workflow-finish": SCHEMA, "hand-over-workflow-finish": SCHEMA },
        },
      },
    },
    script: async (context, bus) => {
      const task = taskOf(context, TaskState.TASK_STATE_COMPLETED, [
        { name: "answer", parts: [dataPart({ text: "hello" })] },
      ]);
      const artifacts = task.artifacts.map((artifact) => ({
        ...artifact,
        metadata: { [A2A_SKILLS_EXTENSION]: { finish } },
      }));
      bus.publish(AgentEvent.task({ ...task, artifacts }));
      bus.finished();
    },
  });
}
