import type { Container } from "../../components/container/container.js";
import type { Class, Token } from "../../components/injection.js";
import type { FrameLease } from "../../flow/context/frame.js";
import type { Clock } from "../../infrastructure/clock.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "../../infrastructure/execution-lease.repository.js";
import { OutboundCalls } from "../../app/outbound-calls.js";
import {
  FencedEffectSettings,
  OutboundCallSettings,
} from "../../infrastructure/fenced-effect-settings.js";
import { FencedEffectRepository } from "../../infrastructure/fenced-effect.repository.js";
import { InMemoryFencedEffectRepository } from "../../infrastructure/in-memory-fenced-effect.repository.js";
import { IN_MEMORY_DATABASE } from "../../infrastructure/in-memory-database.js";
import { InMemoryOutboundCallRepository } from "../../infrastructure/outbound-call.repository.js";
import { OutboundCallRepository } from "../../infrastructure/outbound-call.repository.js";
import { InMemoryDatabase } from "../../infrastructure/in-memory-database.js";
import { seconds } from "../../units/index.js";
import { Logger, SilentLogger } from "../../infrastructure/logger.js";
import type { TestFenceOptions } from "../fence.js";

/**
 * The fenced effects of a unit runner (#500): the built-in in-memory store on a database of the
 * runner's own, and — for every fenced-effect store the runner's container creates, the SQLite one
 * too — the runner's lease in the lease store that store reads (`static leaseRepository`): the
 * fence's token, held until its `confirmedUntil`, released when the options say it was lost. So
 * `testAction` / `testTool` run a component's `saveResultIfAbsent` as a step of a held lease does.
 * The same for the calls that leave the system (#505): `OutboundCalls` over the in-memory
 * outbound-call store, its lease held the same way.
 */
export class UnitFencedEffects {
  readonly core: readonly (readonly [Token, unknown])[] = [
    [IN_MEMORY_DATABASE, new InMemoryDatabase()],
    [FencedEffectSettings, new FencedEffectSettings()],
    [OutboundCallSettings, new OutboundCallSettings()],
  ];

  readonly defaults: ReadonlyMap<Class, Class> = new Map<Class, Class>([
    [FencedEffectRepository, InMemoryFencedEffectRepository],
    // a component that injects the in-memory store by its own class gets the runner's
    [InMemoryFencedEffectRepository, InMemoryFencedEffectRepository],
    [ExecutionLeaseRepository, InMemoryExecutionLeaseRepository],
    [OutboundCallRepository, InMemoryOutboundCallRepository],
    [InMemoryOutboundCallRepository, InMemoryOutboundCallRepository],
    [OutboundCalls, OutboundCalls],
    // what `OutboundCalls` logs: nothing, unless the runner lists a logger
    [Logger, SilentLogger],
  ]);

  /** The fenced-effect stores created and not yet given the runner's lease. */
  readonly #created: object[] = [];
  /** The lease stores the lease is held in: one take each, whatever stores read them. */
  readonly #held = new WeakSet<ExecutionLeaseRepository>();

  constructor(
    private readonly lease: FrameLease,
    private readonly fence: TestFenceOptions,
    private readonly clock: Clock,
  ) {}

  /** The container's hook: a fenced-effect store it created is given the lease before a call. */
  readonly onCreate = (instance: unknown): void => {
    if (instance instanceof FencedEffectRepository || instance instanceof OutboundCallRepository)
      this.#created.push(instance);
  };

  /** Writes the runner's lease into the lease store of every store created since the last call. */
  async hold(container: Container): Promise<void> {
    for (const store of this.#created.splice(0)) {
      const leaseRepository: unknown = Reflect.get(store.constructor, "leaseRepository");
      // a store of its own declares the lease store it reads, a class (`static leaseRepository`)
      const leases =
        typeof leaseRepository === "function" ? container.get(leaseRepository as Class) : undefined;
      if (leases instanceof ExecutionLeaseRepository && !this.#held.has(leases)) {
        this.#held.add(leases);
        await this.#holdIn(leases);
      }
    }
  }

  /** Takes the runner's lease up to its token (an epoch per take) and keeps it, or releases it. */
  async #holdIn(leases: ExecutionLeaseRepository): Promise<void> {
    const { tenantId, leaseExecutionId } = this.lease;
    // until its confirmation: one already past is a lease that expired
    const length = seconds(
      Math.max(0, this.lease.confirmedUntil - this.clock.now().getTime()) / 1000,
    );
    const token = this.fence.token ?? 1;
    for (let epoch = 1; epoch < token; epoch += 1) {
      const taken = await leases.acquire(tenantId, leaseExecutionId, length);
      if (taken !== undefined) await leases.release(taken);
    }
    const held = await leases.acquire(tenantId, leaseExecutionId, length);
    if (held !== undefined && this.fence.isLost === true) await leases.release(held);
  }
}
