import { A2AAgent, A2AClient, A2AEndpoint } from "../../../src/a2a/index.js";
import {
  Agent,
  EmptyEnvironment,
  Injectable,
  Observer,
  MeshLoopDetectedError,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Mesh,
  MeshInboundMode,
  type ExecutionEvent,
  Ttl,
} from "../../../src/index.js";
import { MeshEnvironment } from "./environments/mesh.environment.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import type { Class } from "../../../src/components/injection.js";
import { minutes, type Usd, hours } from "../../../src/units/index.js";
import type { ToolClass } from "../../../src/testing/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toFinish } from "../../helpers/flow.js";
import { HttpAuthenticator, HttpAuthResult, type HttpAuthRequest } from "../../../src/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

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
  /** The peer's name (`billing` → `billing-application`, `billing-workflow-start`); default `peer`. */
  readonly peerName?: string;
  /** The peer agent's contract price of one call (#398 PR 3). */
  readonly price?: Usd;
  readonly maxMeshHops?: number;
  /** The agent's path takes a `MeshLoopDetectedError` to `<name>-loop-workflow-finish`. */
  readonly handlesLoop?: boolean;
  /** `@Application({ mesh })` (#398 PR 2): its keys come from `MeshEnvironment`. */
  readonly mesh?: Class;
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
  readonly MeshA2AExpose: Class;
  readonly MeshDesk: Class;
  readonly CallPeer: ToolClass<PeerQuestion>;
  readonly LoopFinish: Class;
  readonly Authenticator: Class;
  /** Every request the listener's authenticator read, in order. */
  readonly seen: HttpAuthRequest[];
  /** Every execution the application started, as `onExecutionStart` saw it. */
  readonly started: ExecutionEvent[];
}

/** A `@Mesh` that only limits the call chain: nothing signed, nobody a peer. */
function hopsMesh(maxHops: number): Class {
  @Mesh({
    name: "hops-mesh",
    inboundMode: MeshInboundMode.AllowExternal,
    deduplicationTtl: minutes(30),
    maxHops,
  })
  class HopsMesh {}
  return HopsMesh;
}

export function meshAppOf(spec: MeshAppSpec): MeshAppParts {
  const { name } = spec;
  const seen: HttpAuthRequest[] = [];
  const started: ExecutionEvent[] = [];

  const peerName = spec.peerName ?? "peer";
  @A2AAgent({
    name: `${name}-peer-a2a-agent`,
    url: spec.peerUrl,
    target: { application: `${peerName}-application`, skill: `${peerName}-workflow-start` },
    input: WorkflowStartTextDto,
    output: PeerReply,
    ...(spec.price === undefined ? {} : { costPerCall: spec.price }),
  })
  class PeerA2AAgent extends A2AClient<WorkflowStartTextDto, PeerReply> {}

  @Tool({
    name: `${name}-call-peer-tool`,
    description: "Asks the peer application",
    input: PeerQuestion,
    output: PeerReply,
    deps: [PeerA2AAgent],
  })
  class CallPeer {
    constructor(private readonly peerA2AAgent: PeerA2AAgent) {}

    execute({ question }: PeerQuestion): Promise<PeerReply> {
      return this.peerA2AAgent.execute({ text: question });
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

  @HttpAuthenticator()
  class Authenticator {
    authenticate(request: HttpAuthRequest): HttpAuthResult {
      seen.push(request);
      return HttpAuthResult.authenticated(spec.peer === undefined ? {} : { peer: spec.peer });
    }
  }

  const flow =
    spec.handlesLoop === true
      ? onStart(MeshStart)
          .toAgent(MeshDesk)
          .onError(MeshLoopDetectedError, toFinish(LoopFinish))
          .toFinish(MeshAnswer)
      : onStart(MeshStart)
          .toAgent(MeshDesk)
          .toFinish(MeshAnswer);

  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [flow],
    defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
    providers: [PeerA2AAgent, Authenticator, ...(spec.providers ?? [])],
  })
  class MeshWorkflow {}

  @Observer()
  class StartObserver {
    onExecutionStart(event: ExecutionEvent): void {
      started.push(event);
    }
  }

  @A2AEndpoint({
    name: `${name}-a2a-expose`,
    version: "1.0.0",
    description: "Served over A2A",
    ttl: { tasks: hours(24), messages: minutes(15) },
    skills: [MeshStart],
  })
  class MeshA2AExpose {}

  const mesh =
    spec.mesh ?? (spec.maxMeshHops === undefined ? undefined : hopsMesh(spec.maxMeshHops));
  // one of two contracts, as the spec says: the decorator's field types are the union's
  const environment: Class = spec.mesh === undefined ? EmptyEnvironment : MeshEnvironment;
  @Application({
    name: `${name}-application`,
    modelProvider: TestModelProvider,
    endpoints: [MeshA2AExpose],
    version: "1.0.0",
    environment,
    workflows: [MeshWorkflow],
    budgets: TEST_BUDGETS,
    observers: [StartObserver],
    ...(mesh === undefined ? {} : { mesh }),
  })
  class MeshApplication {}

  const workflow = {
    MeshApplication,
    MeshWorkflow,
    MeshStart,
    MeshA2AExpose,
    MeshDesk,
    LoopFinish,
  };
  return { ...workflow, CallPeer, Authenticator, seen, started };
}
