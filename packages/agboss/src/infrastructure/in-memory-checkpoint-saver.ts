import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver, type CheckpointTuple } from "@langchain/langgraph";
import { Injectable } from "../components/decorators.js";
import {
  newestFirstOrder,
  NO_STEP,
  stepOf,
  type LatestByStepCheckpointSaver,
} from "./latest-by-step.js";

/** The steps of a thread's namespace by checkpoint id, and the newest by `(step, id)` of them. */
class StepIndex {
  readonly #steps = new Map<string, number>();
  #newest: string | undefined;

  get newest(): string | undefined {
    return this.#newest;
  }

  /** Notes `id` put at `step`; the newest is found again only when the newest was put again. */
  note(id: string, step: number): void {
    this.#steps.set(id, step);
    const known = this.#newest;
    if (known === undefined || newestFirstOrder(this.#entry(id), this.#entry(known)) < 0)
      this.#newest = id;
    else if (known === id)
      // the newest was put again, maybe lower: the best of the namespace's ids is the newest now
      this.#newest = [...this.#steps.keys()].reduce((best, each) =>
        newestFirstOrder(this.#entry(each), this.#entry(best)) < 0 ? each : best,
      );
  }

  #entry(id: string): { step: number; id: string } {
    return { step: this.#steps.get(id) ?? NO_STEP, id };
  }
}

const place = (config: RunnableConfig): [string, string] => [
  String(config.configurable?.thread_id),
  String(config.configurable?.checkpoint_ns ?? ""),
];

/** The default checkpointer: LangGraph's `MemorySaver` — a pause is lost on restart. */
@Injectable()
export class InMemoryCheckpointSaver extends MemorySaver implements LatestByStepCheckpointSaver {
  /** Each thread's namespaces' step indexes (#962), kept by `put`. */
  readonly #threads = new Map<string, Map<string, StepIndex>>();

  override async put(
    ...[config, checkpoint, metadata]: Parameters<MemorySaver["put"]>
  ): Promise<RunnableConfig> {
    const stored = await super.put(config, checkpoint, metadata);
    const [thread, namespace] = place(config);
    const namespaces = this.#threads.get(thread) ?? new Map<string, StepIndex>();
    this.#threads.set(thread, namespaces);
    const index = namespaces.get(namespace) ?? new StepIndex();
    namespaces.set(namespace, index);
    index.note(checkpoint.id, stepOf(metadata));
    return stored;
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.#threads.delete(threadId);
  }

  /** The newest checkpoint by step of the thread and namespace: one map read, one `getTuple`. */
  latestByStep(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const [thread, namespace] = place(config);
    const newest = this.#threads.get(thread)?.get(namespace)?.newest;
    if (newest === undefined) return Promise.resolve(undefined);
    return this.getTuple({
      configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: newest },
    });
  }

  /** In memory, always reachable (#300). */
  ping(): Promise<void> {
    return Promise.resolve();
  }
}
