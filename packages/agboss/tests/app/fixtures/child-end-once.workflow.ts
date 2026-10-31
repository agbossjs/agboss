import {
  ApplicationContext,
  EmptyEnvironment,
  Injectable,
  LeaseTakeoverReason,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionLeaseTakeoverEvent,
  type OnExecutionEnd,
  type OnExecutionError,
  type OnExecutionLeaseTakeover,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { MemorySaver } from "@langchain/langgraph";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { YieldCheckWorkflow, YieldOneWorkflow } from "./remote-child-yield.workflow.js";

/**
 * #562 — a child's end is announced once, by the pass that ended it. The children are
 * `remote-child-yield.workflow.ts`'s gated check (`gate…` items wait for the test, `fail` ones fail
 * past the gate), on any instance (`YieldOneWorkflow`) or on the parent's (`EndOnceLocalWorkflow`).
 * The observer keeps every end and failure with the instance that announced it, and tells the test
 * at a child's end and at a recovery — the moments a test freezes an instance at.
 */

/** One announcement: which execution, of which workflow, on which instance. */
export interface Announced {
  readonly workflow: string;
  readonly executionId: string;
  readonly instanceId: string;
  readonly error?: string;
}

/** What the observer heard (reset with `resetEndOnce`), and the test's hooks. */
export const endOnceSeen = {
  ends: [] as Announced[],
  errors: [] as Announced[],
  /** Called on the instance that announced a child's end or failure, before it goes on. */
  onChildEnd: undefined as ((instanceId: string) => void) | undefined,
  /** Called on the instance that took a tree over by recovery, before it goes on. */
  onRecovered: undefined as ((instanceId: string) => void) | undefined,
};

export function resetEndOnce(): void {
  window.saver = new MemorySaver();
  window.hook = undefined;
  endOnceSeen.ends.length = 0;
  endOnceSeen.errors.length = 0;
  endOnceSeen.onChildEnd = undefined;
  endOnceSeen.onRecovered = undefined;
}

/** The child workflows: the gated check, and the booking with an undo (#596). */
const CHILDREN: ReadonlySet<string> = new Set(["yield-check-workflow", "undo-child-workflow"]);

/** The announcements of the child workflows' executions. */
export const childrenIn = (seen: readonly Announced[]): readonly Announced[] =>
  seen.filter((each) => CHILDREN.has(each.workflow));

/** The announcements of every other (root) execution. */
export const rootsIn = (seen: readonly Announced[]): readonly Announced[] =>
  seen.filter((each) => !CHILDREN.has(each.workflow));

@WorkflowStart({
  name: "end-once-local-workflow-start",
  description: "One item, checked by one child on this instance",
  input: ItemDto,
})
export class EndOnceLocalWorkflowStart {}

@WorkflowFinish({
  name: "end-once-local-workflow-finish",
  description: "The item the child checked",
  output: ItemResultDto,
})
export class EndOnceLocalWorkflowFinish {}

@Workflow({
  name: "end-once-local-workflow",
  version: "1.0.0",
  flow: [
    start(EndOnceLocalWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(YieldCheckWorkflow)
      .returns(ItemResultDto)
      .toFinish(EndOnceLocalWorkflowFinish),
  ],
})
export class EndOnceLocalWorkflow {}

/** Every end, failure and recovery, with the instance it was heard on. */
@Injectable({ deps: [ApplicationContext] })
export class EndOnceLog implements OnExecutionEnd, OnExecutionError, OnExecutionLeaseTakeover {
  constructor(private readonly applicationContext: ApplicationContext) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    this.#heard(endOnceSeen.ends, event);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    this.#heard(endOnceSeen.errors, event, event.error.name);
  }

  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    if (event.reason === LeaseTakeoverReason.Recovered)
      endOnceSeen.onRecovered?.(this.applicationContext.instanceId);
  }

  #heard(seen: Announced[], event: ExecutionEndEvent | ExecutionErrorEvent, error?: string): void {
    const { instanceId } = this.applicationContext;
    const { executionId } = event;
    const failed = error === undefined ? {} : { error };
    seen.push({ workflow: event.workflow.name, executionId, instanceId, ...failed });
    if (CHILDREN.has(event.workflow.name)) endOnceSeen.onChildEnd?.(instanceId);
  }
}

@Application({
  name: "child-end-once-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [YieldOneWorkflow, EndOnceLocalWorkflow],
  observers: [EndOnceLog],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class ChildEndOnceApplication {}

/** Where a window test freezes the parent's holder: right after its child's end became durable. */
export enum ChildEndPoint {
  /** The parent reads its child's final checkpoint: the last thing before announcing the finish. */
  Finish = "finish",
  /** The child's failed step's error is written: the last write before its failure is announced. */
  Error = "error",
}

/** The checkpoints every instance of a window test shares (reset with `resetEndOnce`). */
const window = {
  saver: new MemorySaver(),
  hook: undefined as { readonly at: ChildEndPoint; readonly run: () => Promise<void> } | undefined,
};

/** Calls `run` once, at `at` on a child's thread, and awaits it before that pass goes on. */
export function atChildEnd(at: ChildEndPoint, run: () => Promise<void>): void {
  window.hook = { at, run };
}

const isChildThread = (config: { readonly configurable?: Record<string, unknown> }): boolean => {
  const thread: unknown = config.configurable?.thread_id;
  return typeof thread === "string" && thread.includes("/child/");
};

/** Runs the hook set for `at`, once. */
async function reached(at: ChildEndPoint): Promise<void> {
  const { hook } = window;
  if (hook?.at !== at) return;
  window.hook = undefined;
  await hook.run();
}

/** The checkpoints in shared memory, with the test's hook at a child's end. */
@Injectable()
export class WindowCheckpointSaver extends MemorySaver {
  constructor() {
    super();
    this.storage = window.saver.storage;
    this.writes = window.saver.writes;
  }

  override async getTuple(
    ...args: Parameters<MemorySaver["getTuple"]>
  ): ReturnType<MemorySaver["getTuple"]> {
    const tuple = await super.getTuple(...args);
    const finish: unknown = tuple?.checkpoint.channel_values.finish;
    if (isChildThread(args[0]) && typeof finish === "string" && finish !== "")
      await reached(ChildEndPoint.Finish);
    return tuple;
  }

  override async putWrites(...args: Parameters<MemorySaver["putWrites"]>): Promise<void> {
    await super.putWrites(...args);
    const [config, writes] = args;
    if (isChildThread(config) && writes.some(([channel]) => channel === "__error__"))
      await reached(ChildEndPoint.Error);
  }
}

@Application({
  name: "child-end-window-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EndOnceLocalWorkflow],
  observers: [EndOnceLog],
  providers: [RecordingLogger, WindowCheckpointSaver],
  budgets: TEST_BUDGETS,
})
export class ChildEndWindowApplication {}
