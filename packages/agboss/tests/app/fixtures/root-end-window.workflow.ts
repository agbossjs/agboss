import { MemorySaver } from "@langchain/langgraph";
import { EmptyEnvironment, Injectable } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { EndOnceLocalWorkflow, EndOnceLog } from "./child-end-once.workflow.js";

/**
 * #597 — a root's end is announced once. The checkpoints of every instance in shared memory, with
 * the test's hook right after the root's last durable write: its finish checkpoint, or its failed
 * step's error — the moment a test freezes the root's holder at, before it announces the end.
 */

/** Where the hook runs: right after the root's end became durable. */
export enum RootEndPoint {
  /** The root's checkpoint with its finish is written. */
  Finish = "finish",
  /** The root's failed step's error is written. */
  Error = "error",
}

const window = {
  saver: new MemorySaver(),
  hook: undefined as { readonly at: RootEndPoint; readonly run: () => Promise<void> } | undefined,
};

/** Fresh shared checkpoints, no hook. */
export function resetRootWindow(): void {
  window.saver = new MemorySaver();
  window.hook = undefined;
}

/** Calls `run` once, at `at` on the root's thread, and awaits it before that pass goes on. */
export function atRootEnd(at: RootEndPoint, run: () => Promise<void>): void {
  window.hook = { at, run };
}

const isRootThread = (config: { readonly configurable?: Record<string, unknown> }): boolean => {
  const thread: unknown = config.configurable?.thread_id;
  return typeof thread === "string" && !thread.includes("/child/");
};

async function reached(at: RootEndPoint): Promise<void> {
  const { hook } = window;
  if (hook?.at !== at) return;
  window.hook = undefined;
  await hook.run();
}

/** The checkpoints in shared memory, with the test's hook at the root's end. */
@Injectable()
export class RootWindowCheckpointSaver extends MemorySaver {
  constructor() {
    super();
    this.storage = window.saver.storage;
    this.writes = window.saver.writes;
  }

  override async put(...args: Parameters<MemorySaver["put"]>): ReturnType<MemorySaver["put"]> {
    const written = await super.put(...args);
    const [config, checkpoint] = args;
    const finish: unknown = checkpoint.channel_values.finish;
    if (isRootThread(config) && typeof finish === "string" && finish !== "")
      await reached(RootEndPoint.Finish);
    return written;
  }

  override async putWrites(...args: Parameters<MemorySaver["putWrites"]>): Promise<void> {
    await super.putWrites(...args);
    const [config, writes] = args;
    if (isRootThread(config) && writes.some(([channel]) => channel === "__error__"))
      await reached(RootEndPoint.Error);
  }
}

@Application({
  name: "root-end-window-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EndOnceLocalWorkflow],
  observers: [EndOnceLog],
  providers: [RecordingLogger, RootWindowCheckpointSaver],
  budgets: TEST_BUDGETS,
})
export class RootEndWindowApplication {}
