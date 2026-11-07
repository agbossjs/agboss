// #810 — the served peer of the end-to-end mesh tests: an AGBoss application whose one exported
// skill answers a question in an action that pays a service, served over A2A v1.0 by the real
// listener (P2a), its mesh signed and verifying the caller.
import "../keys.js";
import { A2AExpose } from "../../../../../src/a2a/a2a-expose.decorator.js";
import { A2ASecurity } from "../../../../../src/a2a/a2a-security.js";
import {
  A2ACallerResolution,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "../../../../../src/a2a/a2a-caller.js";
import { Application } from "../../../../../src/application/application.js";
import type { Class } from "../../../../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../../src/dto/index.js";
import {
  Action,
  Clock,
  Injectable,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnExecutionStart,
  type ExecutionStartEvent,
  type Produced,
} from "../../../../../src/index.js";
import type { Milliseconds } from "../../../../../src/units/index.js";
import { usd } from "../../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../../flow/fixtures/budgets.js";
import { start } from "../../../../helpers/flow.js";
import { MeshEnvironment } from "../../../fixtures/environments/mesh.environment.js";
import {
  A2ATaskState,
  type A2ATaskRecord,
} from "../../../../../src/infrastructure/a2a-task.repository.js";
import { MeshLoopDetectedError } from "../../../../../src/mesh/mesh-errors.js";
import { IN_MEMORY_DATABASE } from "../../../../../src/infrastructure/in-memory-database.js";
import { InMemoryA2ATaskRepository } from "../../../../../src/infrastructure/in-memory-a2a-task.repository.js";

/** The peer's name: the audience a caller's envelope must be addressed to. */
export const PEER_APPLICATION = "peer-application";

/** A question the peer passes on to a further hop that refuses it as a loop. */
export const DOWNSTREAM_LOOP = "downstream-loop";
export const DOWNSTREAM_ENTRY = {
  application: "caller-application",
  start: "caller-workflow-start",
};
export const DOWNSTREAM_CHAIN = [
  { application: "caller-application", start: "caller-workflow-start", executionId: "c-1" },
  { application: PEER_APPLICATION, start: "ask-workflow-start", executionId: "p-1" },
];

/** The caller the resolver authenticates as the mesh peer `caller-application`. */
export const CALLER_TOKEN = "caller";
/** A caller the resolver knows, but as no mesh peer: its envelope is a claim only. */
export const STRANGER_TOKEN = "stranger";
/** A caller the resolver authenticates as another mesh peer than the envelope's issuer. */
export const OTHER_PEER_TOKEN = "other-peer";

/**
 * What the peer's runs do and saw (reset with `resetPeer`): what each answer costs, a gate an
 * answer waits at, every run's input and the contexts its executions started with.
 */
export const peer: {
  spend: number;
  gate: Promise<void> | undefined;
  readonly runs: string[];
  readonly starts: ExecutionStartEvent[];
  /** The test's clock the peer reads (both applications on one time). */
  clock: Clock | undefined;
} = { spend: 3, gate: undefined, runs: [], starts: [], clock: undefined };

/**
 * What the peer's task store loses (#844, reset with `resetPeer`): its next `endsToLose` writes of a
 * `COMPLETED` status — the projection's, at the execution's end: an end event lost, as observer
 * events may be (at most once) — and how many it lost.
 */
export const lossy = { endsToLose: 0, lost: 0 };

export function resetPeer(): void {
  lossy.endsToLose = 0;
  lossy.lost = 0;
  peer.spend = 3;
  peer.gate = undefined;
  peer.runs.length = 0;
  peer.starts.length = 0;
  peer.clock = undefined;
}

/** The peer's clock: the test's, so an envelope the caller signs is fresh on the peer too. */
@Injectable()
export class SharedTestClock extends Clock {
  #own(): Clock {
    if (peer.clock === undefined) throw new Error("the test gave the peer no clock");
    return peer.clock;
  }
  now(): Date {
    return this.#own().now();
  }
  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return this.#own().sleep(delay, signal);
  }
  override monotonicNow(): number {
    return this.#own().monotonicNow();
  }
}

/** `Bearer caller` is the mesh peer `caller-application`; `Bearer stranger` an owner only. */
@Injectable()
export class PeerCallerResolver implements A2ACallerResolver<Class> {
  resolveCaller(request: A2ACallerRequest): A2ACallerResolution<Class> {
    const token = /^Bearer (.+)$/.exec(request.http.headers.authorization ?? "")?.[1];
    if (token === CALLER_TOKEN)
      return A2ACallerResolution.resolved<Class>({
        ownerId: "caller-application",
        peer: "caller-application",
      });
    if (token === STRANGER_TOKEN)
      return A2ACallerResolution.resolved<Class>({ ownerId: "stranger" });
    if (token === OTHER_PEER_TOKEN)
      return A2ACallerResolution.resolved<Class>({
        ownerId: "other-application",
        peer: "other-application",
      });
    return A2ACallerResolution.unauthenticated({ reason: "no token" });
  }
}

/** Sees each execution's start: what the mesh put in its contexts (budget, deadline, origin). */
@Injectable()
export class PeerStarts implements OnExecutionStart {
  onExecutionStart(event: ExecutionStartEvent): void {
    peer.starts.push(event);
  }
}

@Action({
  name: "peer-answer-action",
  description: "Answers the question with a paid service",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [SpendRecorder],
})
export class PeerAnswerAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<WorkflowFinishTextDto> {
    const { text } = input.message.value;
    peer.runs.push(text);
    // a call of the peer's own that a further hop refused as a loop: its run fails with that limit
    if (text === DOWNSTREAM_LOOP)
      throw new MeshLoopDetectedError(DOWNSTREAM_ENTRY, DOWNSTREAM_CHAIN);
    await peer.gate;
    this.spendRecorder.record({ service: "peer-service", cost: usd(peer.spend) });
    return { text: `answered ${text}` };
  }
}

/** The step after the paid one: the budgets are checked before it, the caller's too. */
@Action({
  name: "peer-sign-off-action",
  description: "Signs the answer off",
  input: { answer: WorkflowFinishTextDto },
  output: WorkflowFinishTextDto,
})
export class PeerSignOffAction {
  execute(input: {
    readonly answer: Produced<WorkflowFinishTextDto, unknown>;
  }): Promise<WorkflowFinishTextDto> {
    return Promise.resolve(input.answer.value);
  }
}

@WorkflowStart({
  name: "ask-workflow-start",
  description: "A question for the peer",
  input: WorkflowStartTextDto,
})
export class PeerAskWorkflowStart {}

@WorkflowFinish({
  name: "peer-answer-workflow-finish",
  description: "The peer's answer",
  output: WorkflowFinishTextDto,
})
export class PeerAnswerWorkflowFinish {}

@Workflow({
  name: "peer-workflow",
  version: "1.0.0",
  flow: [
    start(PeerAskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(PeerAnswerAction)
      .returns(WorkflowFinishTextDto)
      .toAction(PeerSignOffAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(PeerAnswerWorkflowFinish),
  ],
})
export class PeerWorkflow {}

@A2AExpose({
  name: "peer-a2a-expose",
  version: "1.0.0",
  description: "Answers questions",
  exports: [PeerAskWorkflowStart],
  security: [A2ASecurity.bearer()],
})
export class PeerA2AExpose {}

const PEER_OPTIONS = {
  name: PEER_APPLICATION,
  version: "1.0.0",
  environment: MeshEnvironment,
  workflows: [PeerWorkflow],
  providers: [SharedTestClock, PeerCallerResolver],
  observers: [PeerStarts],
  exposes: [PeerA2AExpose],
  budgets: TEST_BUDGETS,
  mesh: {
    signingKey: "meshSigningKey",
    peers: [{ application: "caller-application", verifyKey: "meshPeerKey" }],
  },
} as const;

/** The peer: signs its run reports, verifies `caller-application`'s envelopes. */
@Application(PEER_OPTIONS)
export class PeerApplication {}

/** The same peer with no mesh settings at all: no key of its own, no peer it verifies. */
@Application({
  name: PEER_APPLICATION,
  version: "1.0.0",
  environment: MeshEnvironment,
  workflows: [PeerWorkflow],
  providers: [SharedTestClock, PeerCallerResolver],
  observers: [PeerStarts],
  exposes: [PeerA2AExpose],
  budgets: TEST_BUDGETS,
})
export class KeylessPeerApplication {}

/** The same peer refusing any chain of one hop or more (`maxMeshHops: 1`). */
@Application({ ...PEER_OPTIONS, maxMeshHops: 1 })
export class StrictPeerApplication {}

/** The in-memory task store, losing what `lossy` says. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class EndLosingA2ATaskRepository extends InMemoryA2ATaskRepository {
  override compareAndSetStatus(
    ...args: Parameters<InMemoryA2ATaskRepository["compareAndSetStatus"]>
  ): Promise<A2ATaskRecord | undefined> {
    const [, , status] = args;
    if (status.state === A2ATaskState.Completed && lossy.endsToLose > 0) {
      lossy.endsToLose -= 1;
      lossy.lost += 1;
      return Promise.reject(new Error("the end event's write was lost"));
    }
    return super.compareAndSetStatus(...args);
  }
}

/** The peer whose task store loses its end events (#844): its tasks complete by read repair. */
@Application({
  ...PEER_OPTIONS,
  providers: [...PEER_OPTIONS.providers, EndLosingA2ATaskRepository],
})
export class EndLosingPeerApplication {}
