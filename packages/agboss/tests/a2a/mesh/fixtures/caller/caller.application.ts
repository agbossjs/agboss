// #810 — the calling side of the end-to-end mesh tests: an AGBoss application whose one step asks
// the peer through the real A2A v1.0 client (P2b) under `A2AMesh.Required`, at a contract price of
// 1, signing its envelopes — the peer reached at `http://peer.test` through the test's routing.
import "../keys.js";
import { A2AAgent, A2AClient } from "../../../../../src/a2a/index.js";
import { Application } from "../../../../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../../src/dto/index.js";
import {
  Action,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type OnExecutionEnd,
  type OnExecutionError,
  type Produced,
} from "../../../../../src/index.js";
import { usd } from "../../../../../src/units/index.js";
import { Budget, BudgetScope, type BudgetHandler } from "../../../../../src/budgets/budget.js";
import type { Usd } from "../../../../../src/units/index.js";
import {
  TestApplicationDailyBudget,
  TestTenantDailyBudget,
} from "../../../../flow/fixtures/budgets.js";
import { start } from "../../../../helpers/flow.js";
import { MeshEnvironment } from "../../../fixtures/environments/mesh.environment.js";
import { CALLER_TOKEN, PEER_APPLICATION } from "../peer/peer.application.js";

/** Where the client thinks the peer is: its card's interface is there too (the listener's publicUrl). */
export const PEER_URL = "http://peer.test/a2a";
const PEER_ORIGIN = "http://peer.test";

/** The contract price of one call. */
export const PRICE = 1;

/**
 * The calling side's levers and what it saw (reset with `resetCaller`): where the peer really
 * listens, the bearer token sent, how many coming runs of the step freeze after the call (before
 * the step's result is durable), the runs frozen, each pass's answer or error, the ends and errors.
 */
export const caller: {
  origin: string | undefined;
  token: string;
  /** Answers to drop: a SendMessage the peer accepted whose answer never arrives. */
  loseSendAnswers: number;
  /** #849: a lying peer — its GetTask answers say the task COMPLETED with an output. */
  isGetTaskCompleted: boolean;
  freezeAfterCall: number;
  /** How many coming runs of the step freeze after their call failed (before the failure is durable). */
  freezeAfterError: number;
  readonly frozen: (() => void)[];
  readonly answers: string[];
  readonly callErrors: unknown[];
  readonly ends: ExecutionEndEvent[];
  readonly errors: Error[];
  readonly sends: string[];
} = {
  origin: undefined,
  token: CALLER_TOKEN,
  loseSendAnswers: 0,
  isGetTaskCompleted: false,
  freezeAfterCall: 0,
  freezeAfterError: 0,
  frozen: [],
  answers: [],
  callErrors: [],
  ends: [],
  errors: [],
  sends: [],
};

export function resetCaller(): void {
  caller.origin = undefined;
  caller.token = CALLER_TOKEN;
  caller.loseSendAnswers = 0;
  caller.isGetTaskCompleted = false;
  caller.freezeAfterCall = 0;
  caller.freezeAfterError = 0;
  for (const list of [caller.frozen, caller.answers, caller.callErrors, caller.ends]) {
    list.length = 0;
  }
  caller.errors.length = 0;
  caller.sends.length = 0;
}

/** What one caller execution may spend in all: the budget it passes down to the peer. */
export const CALLER_EXECUTION_BUDGET = 5;

@Budget({ name: "test-execution-budget", scope: BudgetScope.Execution })
export class CallerExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(CALLER_EXECUTION_BUDGET);
  }
}

/** The text a lying peer's COMPLETED task answers: never to reach the caller's step. */
export const FREE_WORK = "work the peer refused, done for free";

/** A GetTask answer rewritten as a lying peer's (#849): COMPLETED, with an output artifact. */
async function completedAnswerOf(response: Response): Promise<Response> {
  const body = (await response.json()) as { result?: Record<string, unknown> };
  const task = body.result ?? {};
  const result = {
    ...task,
    status: { state: "TASK_STATE_COMPLETED" },
    artifacts: [{ artifactId: "output", parts: [{ text: FREE_WORK }] }],
  };
  return Response.json({ ...body, result }, { status: response.status });
}

/** The body of a request of `method` (its JSON-RPC text names it); `undefined` for another. */
const bodyOf = (init: RequestInit | undefined, method: string): string | undefined =>
  typeof init?.body === "string" && init.body.includes(`"${method}"`) ? init.body : undefined;

/** The URL a request goes to: `http://peer.test` → the peer's loopback port. */
function targetOf(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (caller.origin === undefined) throw new TypeError("fetch failed: the peer is not served");
  return url.startsWith(PEER_ORIGIN) ? `${caller.origin}${url.slice(PEER_ORIGIN.length)}` : url;
}

/** The peer's address as the test serves it: `http://peer.test` → its loopback port. */
const routed: typeof fetch = async (input, init) => {
  const send = bodyOf(init, "SendMessage");
  if (send !== undefined) caller.sends.push(send);
  const response = await fetch(targetOf(input), init);
  if (send !== undefined && caller.loseSendAnswers > 0) {
    caller.loseSendAnswers -= 1;
    await response.arrayBuffer();
    throw new TypeError("fetch failed: the answer was lost");
  }
  if (bodyOf(init, "GetTask") !== undefined && caller.isGetTaskCompleted) {
    return completedAnswerOf(response);
  }
  // answered as from the peer's address (the loopback is only how the test reaches it)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

@A2AAgent({
  name: "peer-a2a-agent",
  url: PEER_URL,
  target: { application: PEER_APPLICATION, skill: "ask-workflow-start" },
  input: WorkflowStartTextDto,
  output: WorkflowFinishTextDto,
  price: usd(PRICE),
})
export class PeerA2AAgent extends A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto> {
  constructor() {
    super({ fetcher: routed });
  }

  protected override getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ authorization: `Bearer ${caller.token}` });
  }
}

/** An agent of no target application: called with the mesh only if it has it (`IfSupported`). */
@A2AAgent({ name: "any-a2a-agent", url: PEER_URL })
export class AnyA2AAgent extends A2AClient {
  constructor() {
    super({ fetcher: routed });
  }
}

/** Waits until let go when the lever says so. */
async function frozenAfterCall(): Promise<void> {
  if (caller.freezeAfterCall <= 0) return;
  caller.freezeAfterCall -= 1;
  await new Promise<void>((resolve) => caller.frozen.push(resolve));
}

/** Waits until let go after a failed call when the lever says so (#849). */
async function frozenAfterError(): Promise<void> {
  if (caller.freezeAfterError <= 0) return;
  caller.freezeAfterError -= 1;
  await new Promise<void>((resolve) => caller.frozen.push(resolve));
}

@Action({
  name: "ask-peer-action",
  description: "Asks the peer",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [PeerA2AAgent],
})
export class AskPeerAction {
  constructor(private readonly peerA2AAgent: PeerA2AAgent) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<WorkflowFinishTextDto> {
    try {
      const answer = await this.peerA2AAgent.execute({ text: input.message.value.text });
      caller.answers.push(answer.text);
      await frozenAfterCall();
      return answer;
    } catch (error) {
      caller.callErrors.push(error);
      await frozenAfterError();
      throw error;
    }
  }
}

/** Every end and error of the caller's executions, on whichever instance. */
@Injectable()
export class CallerLog implements OnExecutionEnd, OnExecutionError {
  onExecutionEnd(event: ExecutionEndEvent): void {
    caller.ends.push(event);
  }
  onExecutionError(event: ExecutionErrorEvent): void {
    caller.errors.push(event.error);
  }
}

@WorkflowStart({
  name: "caller-workflow-start",
  description: "A question to pass on",
  input: WorkflowStartTextDto,
})
export class CallerWorkflowStart {}

@WorkflowFinish({
  name: "caller-answer-workflow-finish",
  description: "The peer's answer",
  output: WorkflowFinishTextDto,
})
export class CallerAnswerWorkflowFinish {}

@Workflow({
  name: "caller-workflow",
  version: "1.0.0",
  flow: [
    start(CallerWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(AskPeerAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(CallerAnswerWorkflowFinish),
  ],
  providers: [PeerA2AAgent, AnyA2AAgent],
})
export class CallerWorkflow {}

@Application({
  name: "caller-application",
  version: "1.0.0",
  environment: MeshEnvironment,
  workflows: [CallerWorkflow],
  observers: [CallerLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, CallerExecutionBudget],
  mesh: {
    signingKey: "meshSigningKey",
    peers: [{ application: PEER_APPLICATION, verifyKey: "meshPeerKey" }],
  },
})
export class CallerApplication {}
