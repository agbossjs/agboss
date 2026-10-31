import { MemorySaver } from "@langchain/langgraph";
import {
  ApplicationContext,
  EmptyEnvironment,
  Injectable,
  type ExecutionEndEvent,
  type ExecutionLeaseTakeoverEvent,
  type OnExecutionEnd,
  type OnExecutionLeaseTakeover,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { EndOnceLocalWorkflow, EndOnceLog } from "./child-end-once.workflow.js";
import { SidePathLocalWorkflow, UndoLocalWorkflow } from "./child-failure-once.workflow.js";
import { UndoOneWorkflow } from "./finished-undo.workflow.js";
import { YieldOneWorkflow } from "./remote-child-yield.workflow.js";

/**
 * #596 / #597 acceptance — every end of a tree heard once. The roots of `child-end-once` and
 * `child-failure-once` (a child on the parent's instance or on any, with or without an undo, a side
 * path on the child's failure), their checkpoints in memory every instance shares, and the test's
 * hook right before or right after each write that makes an end durable: a child's or a root's
 * failed step's error, a root's finish checkpoint.
 */

/** Where the hook runs. */
export enum DurablePoint {
  ChildErrorBefore = "the child's failed step's error, before it is written",
  ChildErrorAfter = "the child's failed step's error, once written",
  RootFinishBefore = "the root's finish checkpoint, before it is written",
  RootFinishAfter = "the root's finish checkpoint, once written",
  RootErrorBefore = "the root's failed step's error, before it is written",
  RootErrorAfter = "the root's failed step's error, once written",
}

const shared = {
  saver: new MemorySaver(),
  savers: 0,
  hook: undefined as
    | { readonly at: DurablePoint; readonly run: (index: number) => Promise<void> }
    | undefined,
};

/** Fresh shared checkpoints, no hook. */
export function resetMatrix(): void {
  shared.saver = new MemorySaver();
  shared.savers = 0;
  shared.hook = undefined;
  finishesSeen.length = 0;
  takeoversSeen.length = 0;
}

/** Calls `run` once, at `at`, and awaits it before that pass goes on. */
export function atDurable(at: DurablePoint, run: (index: number) => Promise<void>): void {
  shared.hook = { at, run };
}

const isChildThread = (config: { readonly configurable?: Record<string, unknown> }): boolean => {
  const thread: unknown = config.configurable?.thread_id;
  return typeof thread === "string" && thread.includes("/child/");
};

async function reached(at: DurablePoint, index: number): Promise<void> {
  const { hook } = shared;
  if (hook?.at !== at) return;
  shared.hook = undefined;
  await hook.run(index);
}

type Put = Parameters<MemorySaver["put"]>;
type PutWrites = Parameters<MemorySaver["putWrites"]>;

const isFinish = ([config, checkpoint]: Put): boolean => {
  const finish: unknown = checkpoint.channel_values.finish;
  return !isChildThread(config) && typeof finish === "string" && finish !== "";
};

const errorPoints = ([config, writes]: PutWrites): readonly [DurablePoint, DurablePoint] | [] => {
  if (!writes.some(([channel]) => channel === "__error__")) return [];
  return isChildThread(config)
    ? [DurablePoint.ChildErrorBefore, DurablePoint.ChildErrorAfter]
    : [DurablePoint.RootErrorBefore, DurablePoint.RootErrorAfter];
};

/** The checkpoints in shared memory, with the test's hook around each durable end. */
@Injectable()
export class MatrixCheckpointSaver extends MemorySaver {
  /** Its instance's place in the test's `apps`: each instance's container makes its saver in order. */
  private readonly index = (shared.savers += 1) - 1;

  constructor() {
    super();
    this.storage = shared.saver.storage;
    this.writes = shared.saver.writes;
  }

  override async put(...args: Put): ReturnType<MemorySaver["put"]> {
    const finish = isFinish(args);
    if (finish) await reached(DurablePoint.RootFinishBefore, this.index);
    const written = await super.put(...args);
    if (finish) await reached(DurablePoint.RootFinishAfter, this.index);
    return written;
  }

  override async putWrites(...args: PutWrites): Promise<void> {
    const [before, after] = errorPoints(args);
    if (before !== undefined) await reached(before, this.index);
    await super.putWrites(...args);
    if (after !== undefined) await reached(after, this.index);
  }
}

/** The finish each root ended at, with the instance that announced it (reset with `resetMatrix`). */
export const finishesSeen: { finish: string; instanceId: string }[] = [];

/** Every takeover of a lease (any reason): who took it, from whom. */
export const takeoversSeen: { holder: string; previous: string | undefined }[] = [];

/** Keeps every root's finish: which way the tree went, whoever ended it. */
@Injectable({ deps: [ApplicationContext] })
export class FinishLog implements OnExecutionEnd, OnExecutionLeaseTakeover {
  constructor(private readonly applicationContext: ApplicationContext) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    if (event.parentExecutionId !== undefined) return;
    const { instanceId } = this.applicationContext;
    finishesSeen.push({ finish: event.finish.name, instanceId });
  }

  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    const { holderInstanceId: holder, previousHolderInstanceId: previous } = event;
    takeoversSeen.push({ holder, previous });
  }
}

@Application({
  name: "end-once-matrix-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    EndOnceLocalWorkflow,
    YieldOneWorkflow,
    UndoLocalWorkflow,
    UndoOneWorkflow,
    SidePathLocalWorkflow,
  ],
  observers: [EndOnceLog, FinishLog],
  providers: [RecordingLogger, MatrixCheckpointSaver],
  budgets: TEST_BUDGETS,
})
export class EndOnceMatrixApplication {}
