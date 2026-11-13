import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, type CheckpointTuple } from "@langchain/langgraph";

/** What LangGraph's checkpointer contract takes (its types are not all re-exported). */
type ListArguments = Parameters<BaseCheckpointSaver["list"]>;
type PutArguments = Parameters<BaseCheckpointSaver["put"]>;
type PutWritesArguments = Parameters<BaseCheckpointSaver["putWrites"]>;

/** The part of a pass's budgets a checkpoint write waits for. */
export interface SettledSpend {
  /** Resolves once every spend the pass tallied so far is in the ledger. */
  readonly settled: () => Promise<void>;
}

/**
 * A pass's checkpointer that writes a state only once the spend it tallied is in the ledger (#727,
 * #732): a tallied record is kept in the state marked as in the ledger, so no later pass — a
 * takeover, a recovery, the parent of a child on any instance — writes it again; this keeps that
 * mark true of every durable state. A write of the ledger that failed twice fails the checkpoint
 * write, and with it the pass.
 */
export class SettledSpendCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly saver: BaseCheckpointSaver,
    private readonly spend: SettledSpend,
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
    await this.spend.settled();
    return this.saver.put(...putArguments);
  }

  async putWrites(...putWritesArguments: PutWritesArguments): Promise<void> {
    await this.spend.settled();
    return this.saver.putWrites(...putWritesArguments);
  }

  deleteThread(threadId: string): Promise<void> {
    return this.saver.deleteThread(threadId);
  }

  override getNextVersion(current: number | undefined): number {
    return this.saver.getNextVersion(current);
  }
}

/** A pass's checkpointer that writes once its spend is in the ledger; none without one. */
export const settledSaverOf = (
  checkpointer: BaseCheckpointSaver | undefined,
  spend: SettledSpend,
): BaseCheckpointSaver | undefined =>
  checkpointer === undefined ? undefined : new SettledSpendCheckpointSaver(checkpointer, spend);
