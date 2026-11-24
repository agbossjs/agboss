import type { RunnableConfig } from "@langchain/core/runnables";
import { Application } from "../../../src/application/application.js";
import { Channel, Injectable } from "../../../src/components/decorators.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { Bool, Text } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import {
  Action,
  ApplicationContext,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  ExternalTask,
} from "../../../src/index.js";
import { InMemoryCheckpointSaver } from "../../../src/infrastructure/contracts.js";
import { NodeKind, type PathSource } from "../../../src/flow/ast.js";
import { fromSource, type PathBuilder } from "../../../src/flow/path-builder.js";
import type { Class } from "../../../src/components/injection.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { Clock, IdGenerator } from "../../../src/infrastructure/clock.js";
import {
  ExecutionRecordStatus,
  InMemoryExecutionRecordRepository,
} from "../../../src/infrastructure/execution-record.repository.js";
import type { TurnOutcome } from "../../../src/turns/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { days } from "../../../src/units/index.js";

/**
 * #1098 — trees cut off in the window between a task's writes (`putWrites`) and the checkpoint
 * after them (`put`), at a pause's answer: an own-thread child that waits at a question (A), and a
 * tree with two questions in a row (B). The checkpoint savers log every write by thread and
 * namespace, and one of them can be made to never answer: the `put` of the cut's thread and
 * namespace that comes right after that thread's task writes with a result (not an interrupt, not a
 * resume). What ran is counted per step.
 */

const onStart = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

/** One checkpoint write as the saver was asked for it. */
export interface CheckpointWrite {
  readonly op: "put" | "putWrites";
  readonly thread: string;
  readonly namespace: string;
  /** The channels of a `putWrites`; none for a `put`. */
  readonly channels: readonly string[];
  readonly step?: number;
}

/** Channels a task writes when it does not finish. */
const UNFINISHED = new Set(["__interrupt__", "__resume__", "__error__"]);

/** Where the holder is cut off: the thread (a part of its id) and namespace of the `put` that hangs. */
export interface WindowCut {
  /** The thread's id contains it (`/child/` for a child's own thread; `""` for the root's). */
  readonly thread: (threadId: string) => boolean;
  readonly namespace: string;
  /** How many result writes of that thread pass before the cut (0: the first one). */
  readonly skip: number;
}

export const pausesWindow: {
  writes: CheckpointWrite[];
  cut: WindowCut | undefined;
  /** The result writes of the cut's thread seen so far. */
  results: number;
  /** Whether a result write of the cut's thread was saved: its next `put` is the one that hangs. */
  armed: boolean;
  /** The `put` that hung, once it did. */
  hung: CheckpointWrite | undefined;
  /** Each step body that ran, by name and instance. */
  ran: string[];
  /** The pause ids the channels were sent, in order (a channel's pause: only it knows the id). */
  asked: string[];
  /** Runs when a channel is sent a pause, before it answers (its pause is saved, still pending). */
  onAsk: ((pauseId: string) => Promise<void>) | undefined;
  /** Every write of a root's record, in order (#1187): what it wrote, by which instance, landed. */
  records: RecordWrite[];
  /** Runs before a record write (#1187): a rest held, a dead instance's write never made. */
  beforeRecordWrite: ((write: Omit<RecordWrite, "landed">) => Promise<void>) | undefined;
  /** Runs when the approval step runs (#1187: the instance killed there, in the drain's second pass). */
  onApproved: ((instanceId: string) => void) | undefined;
} = {
  writes: [],
  cut: undefined,
  results: 0,
  armed: false,
  hung: undefined,
  ran: [],
  asked: [],
  onAsk: undefined,
  records: [],
  beforeRecordWrite: undefined,
  onApproved: undefined,
};

/** One write of a record (#1187). */
export interface RecordWrite {
  /** `complete` (a holder's rest or end, unconditional) or `mark` (a compare-and-set to running). */
  readonly op: "complete" | "mark";
  readonly status: string;
  readonly instanceId: string;
  readonly landed: boolean;
}

export function resetPausesWindow(): void {
  pausesWindow.writes = [];
  pausesWindow.cut = undefined;
  pausesWindow.results = 0;
  pausesWindow.armed = false;
  pausesWindow.hung = undefined;
  pausesWindow.ran = [];
  pausesWindow.asked = [];
  pausesWindow.onAsk = undefined;
  pausesWindow.records = [];
  pausesWindow.beforeRecordWrite = undefined;
  pausesWindow.onApproved = undefined;
}

/** A record write seen: the test's hook first, then the write, then its log line. */
export async function recordWrite(
  write: Omit<RecordWrite, "landed">,
  made: () => Promise<boolean>,
): Promise<boolean> {
  await pausesWindow.beforeRecordWrite?.(write);
  const landed = await made();
  pausesWindow.records.push({ ...write, landed });
  return landed;
}

/** A channel's send: the pause id kept, the test's hook run. */
async function asked(pauseId: string): Promise<void> {
  pausesWindow.asked.push(pauseId);
  await pausesWindow.onAsk?.(pauseId);
}

interface ConfigArgument {
  readonly configurable?: Record<string, unknown>;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

const factsOf = (
  config: ConfigArgument,
): { readonly thread: string; readonly namespace: string } => ({
  thread: textOf(config.configurable?.thread_id),
  namespace: textOf(config.configurable?.checkpoint_ns),
});

const isCut = (thread: string, namespace: string): boolean => {
  const { cut } = pausesWindow;
  return cut !== undefined && cut.thread(thread) && cut.namespace === namespace;
};

/** Logs a `put`; whether it is the one that never answers. */
export function isHungPut(config: ConfigArgument, step: unknown): boolean {
  const { thread, namespace } = factsOf(config);
  const write: CheckpointWrite = {
    op: "put",
    thread,
    namespace,
    channels: [],
    ...(typeof step === "number" ? { step } : {}),
  };
  pausesWindow.writes.push(write);
  if (!pausesWindow.armed || !isCut(thread, namespace)) return false;
  pausesWindow.armed = false;
  pausesWindow.cut = undefined;
  pausesWindow.hung = write;
  return true;
}

/** Logs a saved `putWrites`; a result write of the cut's thread arms the cut. */
export function wroteWrites(config: ConfigArgument, writes: readonly (readonly unknown[])[]): void {
  const { thread, namespace } = factsOf(config);
  const channels = writes.map((write) => String(write[0]));
  pausesWindow.writes.push({ op: "putWrites", thread, namespace, channels });
  if (!isCut(thread, namespace) || channels.every((channel) => UNFINISHED.has(channel))) return;
  if (pausesWindow.results === pausesWindow.cut?.skip) pausesWindow.armed = true;
  pausesWindow.results += 1;
}

export const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

@Injectable({ deps: [Clock, IdGenerator, ApplicationContext] })
export class PausesWindowMemoryRecords extends InMemoryExecutionRecordRepository {
  readonly #instanceId: string;

  constructor(clock: Clock, idGenerator: IdGenerator, applicationContext: ApplicationContext) {
    super(clock, idGenerator);
    this.#instanceId = applicationContext.instanceId;
  }

  override async complete(turnId: string, outcome: TurnOutcome): Promise<void> {
    const write = { op: "complete" as const, status: outcome.status, instanceId: this.#instanceId };
    await recordWrite(write, async () => {
      await super.complete(turnId, outcome);
      return true;
    });
  }

  override completeIfStatus(
    turnId: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
  ): Promise<boolean> {
    const write = { op: "mark" as const, status: outcome.status, instanceId: this.#instanceId };
    return recordWrite(write, () => super.completeIfStatus(turnId, expected, outcome));
  }
}

@Injectable()
export class PausesWindowMemoryCheckpoints extends InMemoryCheckpointSaver {
  override put(...args: Parameters<InMemoryCheckpointSaver["put"]>): Promise<RunnableConfig> {
    if (isHungPut(args[0], args[2].step)) return never<RunnableConfig>();
    return super.put(...args);
  }

  override async putWrites(
    ...args: Parameters<InMemoryCheckpointSaver["putWrites"]>
  ): Promise<void> {
    await super.putWrites(...args);
    wroteWrites(args[0], args[1]);
  }
}

// ── the steps ──

export class WindowOrderDto {
  @Text({ prompt: "the order" })
  orderId!: string;
}

export class WindowApprovalDto {
  @Bool({ prompt: "whether the order goes on" })
  approved!: boolean;
}

export class WindowReceiptDto {
  @Text({ prompt: "what was done" })
  text!: string;
}

@ExternalTask({
  name: "window-approval-external-task",
  description: "Asks for an order's approval",
  input: WindowOrderDto,
  output: WindowApprovalDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class WindowExternalTask {}

/** Nobody is sent anything: the question waits for its `app.resume`. */
@Channel({
  name: "window-approval-channel",
  description: "Waits for the answer",
  target: WindowExternalTask,
  ttl: days(1),
})
export class WindowChannel {
  async send(ask: ChannelAsk<WindowExternalTask>): Promise<ChannelOutcome<WindowExternalTask>> {
    await asked(ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}

@ExternalTask({
  name: "window-second-approval-external-task",
  description: "Asks for an order's second approval",
  input: WindowOrderDto,
  output: WindowApprovalDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class WindowSecondExternalTask {}

/** Nobody is sent anything: the second question waits for its `app.resume`. */
@Channel({
  name: "window-second-approval-channel",
  description: "Waits for the second answer",
  target: WindowSecondExternalTask,
  ttl: days(1),
})
export class WindowSecondChannel {
  async send(
    ask: ChannelAsk<WindowSecondExternalTask>,
  ): Promise<ChannelOutcome<WindowSecondExternalTask>> {
    await asked(ask.pauseId);
    return ChannelOutcome.awaitReply();
  }
}

/** A step body that counts its runs, by name and instance. */
const ranOn = (name: string, applicationContext: ApplicationContext): void => {
  pausesWindow.ran.push(`${name}@${applicationContext.instanceId}`);
};

@Action({
  name: "window-ask-action",
  description: "Asks for the order's approval",
  input: { order: WindowOrderDto },
  output: WindowOrderDto,
  deps: [ApplicationContext],
})
export class WindowAskAction {
  constructor(private readonly applicationContext: ApplicationContext) {}

  execute(input: { readonly order: Tracked<WindowOrderDto> }): Promise<WindowOrderDto> {
    ranOn("ask", this.applicationContext);
    return Promise.resolve({ orderId: input.order.orderId });
  }
}

@Action({
  name: "window-ask-again-action",
  description: "Asks for the order's second approval",
  input: { approval: WindowApprovalDto, order: WindowOrderDto },
  output: WindowOrderDto,
  deps: [ApplicationContext],
})
export class WindowAskAgainAction {
  constructor(private readonly applicationContext: ApplicationContext) {}

  execute(input: {
    readonly approval: Tracked<WindowApprovalDto>;
    readonly order: Tracked<WindowOrderDto>;
  }): Promise<WindowOrderDto> {
    ranOn("ask-again", this.applicationContext);
    return Promise.resolve({ orderId: input.order.orderId });
  }
}

@Action({
  name: "window-approved-action",
  description: "Goes on with the approved order",
  input: { approval: WindowApprovalDto, order: WindowOrderDto },
  output: WindowReceiptDto,
  deps: [ApplicationContext],
})
export class WindowApprovedAction {
  constructor(private readonly applicationContext: ApplicationContext) {}

  execute(input: {
    readonly approval: Tracked<WindowApprovalDto>;
    readonly order: Tracked<WindowOrderDto>;
  }): Promise<WindowReceiptDto> {
    ranOn("approved", this.applicationContext);
    pausesWindow.onApproved?.(this.applicationContext.instanceId);
    const verdict = input.approval.approved ? "approved" : "refused";
    return Promise.resolve({ text: `${input.order.orderId} ${verdict}` });
  }
}

@Action({
  name: "window-charge-action",
  description: "Charges the order",
  input: { receipt: WindowReceiptDto },
  output: WindowReceiptDto,
  deps: [ApplicationContext],
})
export class WindowChargeAction {
  constructor(private readonly applicationContext: ApplicationContext) {}

  execute(input: { readonly receipt: Tracked<WindowReceiptDto> }): Promise<WindowReceiptDto> {
    ranOn("charge", this.applicationContext);
    return Promise.resolve({ text: `${input.receipt.text}, charged` });
  }
}

// ── A: an own-thread child that waits at a question, its parent charges after it ──

@WorkflowStart({
  name: "window-child-workflow-start",
  description: "An order its approver approves",
  input: WindowOrderDto,
})
export class WindowChildWorkflowStart {}

@WorkflowFinish({
  name: "window-child-workflow-finish",
  description: "The approved order",
  output: WindowReceiptDto,
})
export class WindowChildWorkflowFinish {}

@Workflow({
  name: "window-child-workflow",
  version: "1.0.0",
  flow: [
    onStart(WindowChildWorkflowStart)
      .toAction(WindowAskAction)
      .toExternalTask(WindowExternalTask)
      .toAction(WindowApprovedAction)
      .toFinish(WindowChildWorkflowFinish),
  ],
})
export class WindowChildWorkflow {}

@WorkflowStart({
  name: "window-parent-workflow-start",
  description: "An order a child approves",
  input: WindowOrderDto,
})
export class WindowParentWorkflowStart {}

@WorkflowFinish({
  name: "window-parent-workflow-finish",
  description: "The charged order",
  output: WindowReceiptDto,
})
export class WindowParentWorkflowFinish {}

@Workflow({
  name: "window-parent-workflow",
  version: "1.0.0",
  flow: [
    onStart(WindowParentWorkflowStart)
      .toWorkflow(WindowChildWorkflow)
      .toAction(WindowChargeAction)
      .toFinish(WindowParentWorkflowFinish),
  ],
})
export class WindowParentWorkflow {}

// ── B: two questions in a row, then the charge ──

@WorkflowStart({
  name: "window-twice-workflow-start",
  description: "An order approved twice",
  input: WindowOrderDto,
})
export class WindowTwiceWorkflowStart {}

@WorkflowFinish({
  name: "window-twice-workflow-finish",
  description: "The charged order",
  output: WindowReceiptDto,
})
export class WindowTwiceWorkflowFinish {}

@Workflow({
  name: "window-twice-workflow",
  version: "1.0.0",
  flow: [
    onStart(WindowTwiceWorkflowStart)
      .toAction(WindowAskAction)
      .toExternalTask(WindowExternalTask)
      .toAction(WindowAskAgainAction)
      .toExternalTask(WindowSecondExternalTask)
      .toAction(WindowApprovedAction)
      .toAction(WindowChargeAction)
      .toFinish(WindowTwiceWorkflowFinish),
  ],
})
export class WindowTwiceWorkflow {}

export const pausesWindowWorkflows = [
  WindowParentWorkflow,
  WindowChildWorkflow,
  WindowTwiceWorkflow,
];

@Application({
  name: "pauses-window-memory-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: pausesWindowWorkflows,
  observers: [RecoveryLog],
  providers: [
    PausesWindowMemoryCheckpoints,
    PausesWindowMemoryRecords,
    MortalExecutionLeaseRepository,
    WindowChannel,
    WindowSecondChannel,
  ],
  budgets: TEST_BUDGETS,
})
export class PausesWindowMemoryApplication {}
