import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, type CheckpointTuple } from "@langchain/langgraph";
import type { HeldExecutionLease } from "./execution-leases.js";

/** What LangGraph's checkpointer contract takes (its types are not all re-exported). */
type ListArguments = Parameters<BaseCheckpointSaver["list"]>;
type PutArguments = Parameters<BaseCheckpointSaver["put"]>;
type PutWritesArguments = Parameters<BaseCheckpointSaver["putWrites"]>;

/**
 * The application's checkpointer as one pass over a tree sees it (#265, Q58): every write renews
 * the tree's lease first, so a holder that lost it never writes. Documented limit: the renewal and
 * the write are two round trips, not one atomic operation (any `BaseCheckpointSaver` plugs in).
 */
export class LeasedCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly saver: BaseCheckpointSaver,
    private readonly lease: HeldExecutionLease,
  ) {
    super(saver.serde);
  }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.saver.getTuple(config);
  }

  list(...listArguments: ListArguments): AsyncGenerator<CheckpointTuple> {
    return this.saver.list(...listArguments);
  }

  async put(...putArguments: PutArguments): Promise<RunnableConfig> {
    await this.lease.renewNow();
    return this.saver.put(...putArguments);
  }

  async putWrites(...putWritesArguments: PutWritesArguments): Promise<void> {
    await this.lease.renewNow();
    return this.saver.putWrites(...putWritesArguments);
  }

  deleteThread(threadId: string): Promise<void> {
    return this.saver.deleteThread(threadId);
  }

  override getNextVersion(current: number | undefined): number {
    return this.saver.getNextVersion(current);
  }
}
