/**
 * #746: a paused-execution store that reads a pause back only when its ask is a tool call — the
 * row check @agboss/postgres and @agboss/mongodb shipped (`ask: { callId, tool, summary }`), written
 * before question roles (#659) made an ask the role's own DTO. Every approval's pause passes.
 */
import {
  InMemoryPausedExecutionRepository,
  type PauseRecord,
} from "../../../src/infrastructure/paused-execution.repository.js";

const isToolCallAsk = (ask: unknown): boolean =>
  typeof ask === "object" &&
  ask !== null &&
  ["callId", "tool", "summary"].every((field) => typeof Reflect.get(ask, field) === "string");

/** The stored pause, refused as unreadable unless its ask is a tool call. */
function checked(pause: PauseRecord): PauseRecord {
  if (!isToolCallAsk(pause.ask))
    throw new Error(`a stored pause is not readable: ${pause.pauseId}`);
  return pause;
}

export class ApprovalOnlyPausedExecutionRepository extends InMemoryPausedExecutionRepository {
  override async findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return checked(await super.findOrCreateByStepKey(pause));
  }

  override async findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined> {
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    return found === undefined ? undefined : checked(found);
  }

  override async findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<PauseRecord[]> {
    return (await super.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId)).map(
      checked,
    );
  }
}
