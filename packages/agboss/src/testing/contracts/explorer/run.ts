import { NO_ENVIRONMENT_VALUES } from "../../../environments/resolve.js";
import { applicationContextOf } from "../../../flow/context/application-context.js";
import { TEST_START, VirtualClock } from "../../clock.js";
import { SkewedClock } from "../../clock-skew.js";
import { TestStoreClock } from "../../store-clock.js";
import type { ContractTarget, StoreSeam } from "../seam.js";
import { trackedStore } from "../tracked-store.js";
import { stepOf } from "./moves.js";
import { Observer } from "./observer.js";
import type { CallPhase } from "./calls.js";
import {
  ExplorerInvariant,
  type ExplorerAction,
  type ExplorerStores,
  type ExplorerWorld,
} from "./types.js";

/**
 * One schedule's live world (#533 item 1): a new clock, the backing store reset, one store per
 * simulated instance — each on its own skewed clock, every store on the run's time — and the
 * observer. Each action runs alone: the next is sent only once the store answered the one before,
 * so the order the scheduler chose is the order the store sees, whatever the store.
 */

/** One step as it ran: the action and what happened, for the printed schedule. */
export interface RanStep {
  readonly action: ExplorerAction;
  readonly label: string;
}

/** The live state of one schedule. */
export class ExplorerRun {
  readonly clock = new VirtualClock(new Date(TEST_START));
  readonly observer = new Observer();
  readonly phases = new Map<string, CallPhase>();
  readonly writes = new Set<string>();
  readonly steps: RanStep[] = [];
  readonly stores: ExplorerStores[] = [];
  readonly #built: ExplorerStores[] = [];
  #owners = 0;

  private constructor(
    readonly world: ExplorerWorld,
    readonly target: ContractTarget<ExplorerStores>,
  ) {}

  /** A new run: the backing store reset and every instance's stores built. */
  static async open(
    world: ExplorerWorld,
    target: ContractTarget<ExplorerStores>,
  ): Promise<ExplorerRun> {
    const run = new ExplorerRun(world, target);
    await target.reset?.();
    for (let instance = 1; instance <= world.instances; instance += 1) {
      const built = await target.instance(run.#seamOf(instance));
      run.#built.push(built);
      run.stores.push(trackedStore(built, run.clock));
    }
    return run;
  }

  /** The time of the run, in ms. */
  get now(): number {
    return this.clock.now().getTime();
  }

  /** The stores of `instance` (1-based). */
  storesOf(instance: number): ExplorerStores {
    const stores = this.stores[instance - 1];
    if (stores === undefined) throw new RangeError(`no instance-${String(instance)}`);
    return stores;
  }

  /** The phase of `instance`'s call on `tree`. */
  phaseOf(instance: number, tree: string): CallPhase {
    return this.phases.get(`${String(instance)}|${tree}`) ?? { phase: "read" };
  }

  setPhase(instance: number, tree: string, phase: CallPhase): void {
    this.phases.set(`${String(instance)}|${tree}`, phase);
  }

  /** A fresh attempt owner, the same on every replay. */
  newOwner(instance: number): string {
    this.#owners += 1;
    return `owner-${String(instance)}-${String(this.#owners)}`;
  }

  /** Runs `action`; an error that is not the fence's refusal is a violation. */
  async step(action: ExplorerAction): Promise<void> {
    let label: string;
    try {
      label = await stepOf(this, action);
    } catch (error) {
      label = `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      if (!isFenced(error))
        this.observer.fail(ExplorerInvariant.StoreError, `${describe(action)} ${label}`);
    }
    this.steps.push({ action, label });
  }

  /** What the search remembers of the state. */
  get key(): string {
    return JSON.stringify([this.observer.keyOf(this.now), [...this.phases], [...this.writes]]);
  }

  /** Closes every store built. */
  async close(): Promise<void> {
    for (const stores of this.#built) await this.target.close?.(stores);
  }

  #seamOf(instance: number): StoreSeam {
    const instanceId = `instance-${String(instance)}`;
    return {
      clock: new SkewedClock(this.clock, this.world.skewOf(instance)),
      storeClock: new TestStoreClock(this.clock),
      instanceId,
      application: applicationContextOf({
        name: "interleaving-explorer-application",
        version: "1.0.0",
        instanceId,
        startedAt: this.clock.now(),
        environmentName: "test",
        environment: NO_ENVIRONMENT_VALUES,
      }),
    };
  }
}

/** Whether `error` is the fence's refusal: a hand-over, the answer a stale write gets. */
export const isFenced = (error: unknown): boolean =>
  error instanceof Error && error.name === "ExecutionFencedError";

/** An action as the printed schedule names it. */
export function describe(action: ExplorerAction): string {
  if (action.kind === "time") return `time ${action.step}`;
  const who = `instance-${String(action.instance)}`;
  if (action.kind === "lease") return `${who} ${action.operation} ${action.tree}`;
  if (action.kind === "deliver")
    return `${who}'s request on ${action.tree} reaches the other system: ${action.isAccepted ? "charged" : "declined"}`;
  return `${who} ${action.kind} ${action.tree}`;
}
