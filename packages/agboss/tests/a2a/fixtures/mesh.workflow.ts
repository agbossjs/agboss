import {
  A2AAgent,
  A2AClient,
  A2ACallerResolution,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "../../../src/a2a/index.js";
import {
  Agent,
  EmptyEnvironment,
  Injectable,
  MeshLoopDetectedError,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionEvent,
  type MeshOptions,
  type OnExecutionStart,
  type ToolHandler,
} from "../../../src/index.js";
import { MeshEnvironment } from "./environments/mesh.environment.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import type { Class } from "../../../src/components/injection.js";
import type { ToolClass } from "../../../src/testing/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start, toFinish } from "../../helpers/flow.js";

/**
 * One application of a mesh (#398): its agent asks a peer application over A2A through one tool,
 * its listener's resolver records every request it reads. Built per test, once both peers' URLs are
 * known, so two of them can call each other.
 */

export class PeerQuestion {
  @Text({ prompt: "the question for the peer" })
  question!: string;
}

export class PeerReply {
  @Text()
  text!: string;
}

/** How one mesh application is made: its name, its peer's URL and its own limits. */
export interface MeshAppSpec {
  /** `orders` → `orders-application`, `orders-workflow-start`, `orders-desk-agent`, … */
  readonly name: string;
  readonly peerUrl: string;
  readonly maxMeshHops?: number;
  /** The agent's path takes a `MeshLoopDetectedError` to `<name>-loop-workflow-finish`. */
  readonly handlesLoop?: boolean;
  /** `@Application({ mesh })` (#398 PR 2): its keys come from `MeshEnvironment`. */
  readonly mesh?: MeshOptions;
  /** The peer the listener's resolver names for every request (as if its transport proved it). */
  readonly peer?: string;
  /** More providers of its workflow (a listener's `meshVerifier`). */
  readonly providers?: readonly Class[];
}

/** The parts a test drives. */
export interface MeshAppParts {
  readonly MeshApplication: Class;
  readonly MeshWorkflow: Class;
  readonly MeshStart: Class;
  readonly MeshDesk: Class;
  readonly CallPeer: ToolClass<PeerQuestion>;
  readonly LoopFinish: Class;
  readonly Resolver: Class<A2ACallerResolver<Class>>;
  /** Every request the listener's resolver read, in order. */
  readonly seen: A2ACallerRequest[];
  /** Every execution the application started, as `onExecutionStart` saw it. */
  readonly started: ExecutionEvent[];
}

export function meshAppOf(spec: MeshAppSpec): MeshAppParts {
  const { name } = spec;
  const seen: A2ACallerRequest[] = [];
  const started: ExecutionEvent[] = [];

  @A2AAgent({ name: `${name}-peer-a2a-agent`, url: spec.peerUrl })
  class PeerAgent extends A2AClient {}

  @Tool({
    name: `${name}-call-peer-tool`,
    description: "Asks the peer application",
    input: PeerQuestion,
    output: PeerReply,
    deps: [PeerAgent],
  })
  class CallPeer implements ToolHandler<PeerQuestion, PeerReply> {
    constructor(private readonly peerAgent: PeerAgent) {}

    run({ question }: PeerQuestion): Promise<PeerReply> {
      return this.peerAgent.execute({ text: question }, PeerReply);
    }
  }

  @Agent({
    name: `${name}-desk-agent`,
    description: "Answers with the peer's help",
    model: `test/${name}`,
    price: { inputPerMTok: 1, outputPerMTok: 2 },
    tools: [CallPeer],
  })
  class MeshDesk {}

  @WorkflowStart({
    name: `${name}-workflow-start`,
    description: "A question",
    input: WorkflowStartTextDto,
  })
  class MeshStart {}

  @WorkflowFinish({
    name: `${name}-answer-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class MeshAnswer {}

  @WorkflowFinish({
    name: `${name}-loop-workflow-finish`,
    description: "The question, handed back: the mesh looped",
    output: WorkflowStartTextDto,
  })
  class LoopFinish {}

  @Injectable()
  class Resolver implements A2ACallerResolver<typeof MeshStart> {
    resolveCaller(request: A2ACallerRequest): A2ACallerResolution<typeof MeshStart> {
      seen.push(request);
      return A2ACallerResolution.resolved(spec.peer === undefined ? {} : { peer: spec.peer });
    }
  }

  const flow = spec.handlesLoop === true
    ? start(MeshStart)
        .returns(WorkflowStartTextDto)
        .toAgent(MeshDesk)
        .onError(
          MeshLoopDetectedError,
          toFinish(LoopFinish),
        )
        .toFinish(MeshAnswer)
    : start(MeshStart)
        .returns(WorkflowStartTextDto)
        .toAgent(MeshDesk)
        .toFinish(MeshAnswer);

  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [flow],
    defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
    providers: [PeerAgent, Resolver, ...(spec.providers ?? [])],
  })
  class MeshWorkflow {}

  @Injectable()
  class StartObserver implements OnExecutionStart {
    onExecutionStart(event: ExecutionEvent): void {
      started.push(event);
    }
  }

  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: spec.mesh === undefined ? EmptyEnvironment : MeshEnvironment,
    workflows: [MeshWorkflow],
    budgets: TEST_BUDGETS,
    observers: [StartObserver],
    ...(spec.maxMeshHops === undefined ? {} : { maxMeshHops: spec.maxMeshHops }),
    ...(spec.mesh === undefined ? {} : { mesh: spec.mesh }),
  })
  class MeshApplication {}

  const workflow = { MeshApplication, MeshWorkflow, MeshStart, MeshDesk, LoopFinish };
  return { ...workflow, CallPeer, Resolver, seen, started };
}
