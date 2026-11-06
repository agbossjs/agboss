/**
 * 0.1.1: a paused-execution store that drops a pause's `kind` and reads it back from the component
 * — the rule @agboss/postgres and @agboss/mongodb applied before `PauseRecord.kind` was stored.
 * Every pause the framework makes passes; the contract's kind case does not.
 */
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { PauseKind } from "../../../src/infrastructure/pause-record.js";
import {
  InMemoryPausedExecutionRepository,
  type PauseRecord,
} from "../../../src/infrastructure/paused-execution.repository.js";

/** The stored pause with its kind told by its component, as before 0.1.1. */
const inferred = (pause: PauseRecord): PauseRecord => ({
  ...pause,
  kind: pause.component?.kind === ComponentKind.Question ? PauseKind.Question : PauseKind.Approval,
});

export class KindInferredPausedExecutionRepository extends InMemoryPausedExecutionRepository {
  override async findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    return inferred(await super.findOrCreateByStepKey(pause));
  }

  override async findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined> {
    const found = await super.findByTenantIdAndPauseId(tenantId, pauseId);
    return found === undefined ? undefined : inferred(found);
  }

  override async findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<PauseRecord[]> {
    return (await super.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId)).map(
      inferred,
    );
  }
}
