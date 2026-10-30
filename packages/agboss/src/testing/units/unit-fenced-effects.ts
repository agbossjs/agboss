import type { Class, Token } from "../../components/injection.js";
import type { FrameLease } from "../../flow/context/frame.js";
import type { TestFenceOptions } from "../fence.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../infrastructure/fenced-effect-settings.js";
import { FencedEffectRepository } from "../../infrastructure/fenced-effect.repository.js";
import { InMemoryFencedEffectRepository } from "../../infrastructure/in-memory-fenced-effect.repository.js";
import { IN_MEMORY_DATABASE } from "../../infrastructure/instance-tokens.js";
import { InMemoryDatabase, treeKeyOf } from "../../infrastructure/in-memory-database.js";

/**
 * The fenced effects of a unit runner (#500): the built-in in-memory store, on a database of its
 * own that holds the runner's lease — the fence's token, held until its `confirmedUntil`, released
 * when the options say the lease was lost — so `testAction` / `testTool` run a component's
 * `saveResultIfAbsent` as a step of a held lease does.
 */
export interface UnitFencedEffects {
  readonly core: readonly (readonly [Token, unknown])[];
  readonly defaults: ReadonlyMap<Class, Class>;
}

export function unitFencedEffects(lease: FrameLease, fence: TestFenceOptions): UnitFencedEffects {
  const database = new InMemoryDatabase();
  database.executionLeases.set(treeKeyOf(lease.tenantId, lease.leaseExecutionId), {
    lease: {
      tenantId: lease.tenantId,
      rootExecutionId: lease.leaseExecutionId,
      holderInstanceId: "test-instance",
      leaseEpoch: fence.token ?? 1,
      expiresAt: new Date(lease.confirmedUntil),
    },
    released: fence.isLost === true,
  });
  return {
    core: [
      [IN_MEMORY_DATABASE, database],
      [FencedEffectSettings, new FencedEffectSettings()],
    ],
    defaults: new Map<Class, Class>([
      [FencedEffectRepository, InMemoryFencedEffectRepository],
      // a component that injects the in-memory store by its own class gets the runner's
      [InMemoryFencedEffectRepository, InMemoryFencedEffectRepository],
      [ExecutionLeaseRepository, InMemoryExecutionLeaseRepository],
    ]),
  };
}
