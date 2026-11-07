import { createAppWith } from "../../../../src/application/create-app.js";
import { A2AAgent, A2AClient, type A2AMesh, type A2ATarget } from "../../../../src/a2a/index.js";
import {
  Agent,
  EmptyEnvironment,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import type { App } from "../../../../src/app/types.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import type { ToolClass } from "../../../../src/testing/index.js";
import type { Class } from "../../../../src/components/injection.js";
import { callTool, replyWith } from "../../../../src/testing/index.js";
import { ScriptBook } from "../../../../src/testing/script-book.js";
import type { Milliseconds, Usd } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { execute, start } from "../../../helpers/flow.js";
import { MeshEnvironment } from "../../fixtures/environments/mesh.environment.js";
import { meshEnvOf, meshOf, type MeshKeyPair } from "../../fixtures/mesh-keys.js";
import { offline } from "../../fixtures/remote.workflow.js";
import { AGENT_URL, type SdkAgent } from "../support/sdk-agent.js";

/**
 * An application whose agent calls an A2A agent through one tool (#809): the client is the new
 * `A2AClient` under `@A2AAgent`, its `fetcher` the test's in-process SDK agent. Built per test.
 */

export class AskDto {
  @Text({ prompt: "the question" })
  question!: string;
}

export class ReplyDto {
  @Text()
  text!: string;
}

export interface CallerSpec {
  readonly agent: SdkAgent;
  /** `caller` → `caller-application`, `caller-workflow-start`. */
  readonly name?: string;
  readonly target?: A2ATarget;
  readonly price?: Usd;
  readonly mesh?: A2AMesh;
  readonly timeout?: Milliseconds;
  /** How many times the tool calls the agent in one run, each with its own question. */
  readonly callsPerRun?: number;
  /** The application signs its envelopes (`mesh.signingKey`) and knows `peer-application`'s key. */
  readonly signing?: { readonly own: MeshKeyPair; readonly peer: MeshKeyPair };
}

export interface CallerParts {
  readonly app: App;
  readonly Start: new () => object;
  readonly Ask: ToolClass<AskDto>;
  /** Runs one question through the agent's tool; the run's result. */
  readonly ask: (question: string) => ReturnType<typeof execute>;
  /** What the tool's calls threw, in order (the tool throws them on). */
  readonly errors: unknown[];
  /** What each call gave. */
  readonly replies: ReplyDto[];
}

export async function callerOf(spec: CallerSpec): Promise<CallerParts> {
  const name = spec.name ?? "caller";
  const { agent } = spec;
  const errors: unknown[] = [];
  const replies: ReplyDto[] = [];

  @A2AAgent({
    name: `${name}-peer-a2a-agent`,
    url: AGENT_URL,
    ...(spec.target === undefined ? {} : { target: spec.target }),
    input: WorkflowStartTextDto,
    output: ReplyDto,
    ...(spec.price === undefined ? {} : { price: spec.price }),
    ...(spec.mesh === undefined ? {} : { mesh: spec.mesh }),
  })
  class PeerA2AAgent extends A2AClient<WorkflowStartTextDto, ReplyDto> {
    constructor() {
      super({ fetcher: agent.fetcher });
    }
  }

  @Tool({
    name: `${name}-ask-tool`,
    description: "Asks the agent",
    input: AskDto,
    output: ReplyDto,
    deps: [PeerA2AAgent],
  })
  class Ask implements ToolHandler<AskDto, ReplyDto> {
    constructor(private readonly peer: PeerA2AAgent) {}

    async run({ question }: AskDto): Promise<ReplyDto> {
      const calls = spec.callsPerRun ?? 1;
      let reply: ReplyDto = { text: "" };
      for (let index = 0; index < calls; index += 1) {
        const call = spec.timeout === undefined ? {} : { timeout: spec.timeout };
        try {
          reply = await this.peer.execute({ text: `${question}#${String(index)}` }, call);
          replies.push(reply);
        } catch (error) {
          errors.push(error);
          throw error;
        }
      }
      return reply;
    }
  }

  @Agent({
    name: `${name}-desk-agent`,
    description: "Answers with the agent's help",
    model: `test/${name}`,
    price: { inputPerMTok: 1, outputPerMTok: 2 },
    tools: [Ask],
  })
  class Desk {}

  @WorkflowStart({
    name: `${name}-workflow-start`,
    description: "A question",
    input: WorkflowStartTextDto,
  })
  class Start {}

  @WorkflowFinish({
    name: `${name}-answer-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class Answer {}

  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [start(Start).returns(WorkflowStartTextDto).toAgent(Desk).toFinish(Answer)],
    defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
    providers: [PeerA2AAgent],
  })
  class CallerWorkflow {}

  const environment: Class = spec.signing === undefined ? EmptyEnvironment : MeshEnvironment;
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment,
    workflows: [CallerWorkflow],
    budgets: TEST_BUDGETS,
    ...(spec.signing === undefined ? {} : { mesh: meshOf("peer-application") }),
  })
  class CallerApplication {}

  const book = new ScriptBook();
  const signing =
    spec.signing === undefined
      ? {}
      : { env: "signing", processEnv: meshEnvOf(spec.signing.own, spec.signing.peer) };
  const app = await createAppWith(CallerApplication, { ...offline(book), ...signing });
  const ask = (question: string) => {
    book
      .scriptOf(`agent:${name}-desk-agent`)
      .thenReturn(callTool(Ask, { question }), replyWith("done"));
    return execute(app, Start, { text: question });
  };
  return { app, Start, Ask, ask, errors, replies };
}
