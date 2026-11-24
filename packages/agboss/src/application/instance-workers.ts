import type { BuiltApp } from "../app/create-app.js";
import {
  executionLeasesOf,
  type AuditLogWriter,
  type ExecutionLeases,
} from "../app/execution-leases.js";
import type { ForkLauncher } from "../app/remote/isolated-supervisor.js";
import type { StepHolds } from "../app/step-slots.js";
import { launchesQueued } from "../flow/analyse/child-placements.js";
import { leasingOf, type Infrastructure } from "../infrastructure/contracts.js";
import { lazyLoad, type Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { RecoverySweep } from "../infrastructure/recovery.js";
import type { AssembledApplication } from "./assemble.js";
import type { InstanceSeams } from "./instance-seams.js";
import type { StepsAtStop } from "./instance-steps.js";
import type { PauseTimers } from "./pause-timers.js";

/**
 * The workers of one application instance besides its executions: the claims of queued children
 * (#333 PR 2), the supervisor of its isolated workers (#1286b) and, in the fork of an isolated
 * worker, its one targeted claim and the idle looks that stand in for the sweep and the pause timers.
 */

/** What an instance needs of `@Application({ isolatedWorker })` (#1286b). */
export interface IsolatedParts {
  /** Set in the fork of an isolated child: the child it runs. */
  readonly child?: InstanceSeams["isolatedChild"] | undefined;
  /** How its supervisor starts a process; absent = a child process. */
  readonly launch?: ForkLauncher | undefined;
  /** The environment the instance runs with: what a fork is started with. */
  readonly environmentName?: string | undefined;
}

/** What an instance's seams and contexts give its isolated workers (#1286b). */
export const isolatedPartsOf = (
  seams: Pick<InstanceSeams, "isolatedChild" | "isolatedLauncher">,
  contexts: { readonly application: { readonly environmentName: string } },
): IsolatedParts => ({
  child: seams.isolatedChild,
  launch: seams.isolatedLauncher,
  environmentName: contexts.application.environmentName,
});

/** What the workers read of the instance. */
export interface WorkerParts {
  readonly infrastructure: Infrastructure;
  readonly log: FrameworkLog;
  readonly stepSlots?: StepHolds | undefined;
  readonly isolated?: IsolatedParts | undefined;
  readonly stepsAtStop: StepsAtStop;
  readonly auditLog?: AuditLogWriter;
}

/** A worker that stops. */
interface Stoppable {
  readonly stop: () => Promise<void>;
}

const NONE: Stoppable = { stop: () => Promise.resolve() };

/** Whether a workflow of the instance launches a child on any instance (#333 PR 2). */
const launchesAnywhere = (workflows: readonly BuiltApp[]): boolean =>
  workflows.some((workflow) => launchesQueued(workflow.deps.graph.nodes.values()));

/** The leases of the instance's lease holders (its child workers), on its leasing (#471). */
function leasesOf(infrastructure: Infrastructure, events?: AuditLogWriter): ExecutionLeases {
  const { repository, clock } = leasingOf(infrastructure);
  return executionLeasesOf(repository, clock, { events });
}

/**
 * The instance's claims of queued children (#333 PR 2), loaded and started only when one of its
 * workflows launches a child on any instance — in the fork of an isolated worker (#1286b), its one
 * targeted claim; `stop()` resolves once they ended.
 */
export function childWorkersOf(
  workflows: readonly BuiltApp[],
  parts: WorkerParts,
  interruption: AbortSignal,
): Stoppable {
  const target = parts.isolated?.child;
  if (target === undefined && !launchesAnywhere(workflows)) return NONE;
  const { infrastructure, log } = parts;
  const started = Promise.all([
    lazyLoad(import("../app/remote/child-workers.js")),
    lazyLoad(import("../app/remote/child-target-worker.js")),
    lazyLoad(import("../app/remote/child-registry.js")),
  ]).then(([workers, targeted, registry]) => {
    const own = {
      queue: infrastructure.childQueue,
      leases: leasesOf(infrastructure, parts.auditLog),
      trees: infrastructure.executionTrees,
      clock: infrastructure.clock,
      log,
      capacity: parts.stepSlots,
      interruption,
      registry: registry.childRegistryOf(workflows),
      serde: infrastructure.checkpointer.serde,
    };
    return target === undefined
      ? workers.startChildWorkers(own)
      : targeted.startTargetWorker(own, target);
  });
  return { stop: async () => (await started).stop() };
}

/**
 * The instance's supervisor of isolated workers (#1286b): only when the application sets
 * `isolatedWorker`, and never in a fork — a fork runs its one child and starts nothing.
 */
export function isolatedSupervisorOf(
  assembled: AssembledApplication,
  parts: WorkerParts,
): Stoppable {
  const entry = assembled.isolatedWorker?.entry;
  if (entry === undefined || parts.isolated?.child !== undefined) return NONE;
  const { infrastructure, log } = parts;
  const started = Promise.all([
    lazyLoad(import("../app/remote/isolated-supervisor.js")),
    lazyLoad(import("../app/remote/isolated-fork.js")),
  ]).then(([supervisor, fork]) =>
    supervisor.startIsolatedSupervisor({
      queue: infrastructure.childQueue,
      clock: infrastructure.clock,
      log,
      spec: {
        entry,
        environmentName: parts.isolated?.environmentName,
        profile: assembled.profileSelection,
      },
      launch: parts.isolated?.launch ?? fork.launchFork,
      slots: parts.stepSlots,
      deadline: parts.stepsAtStop.signal,
    }),
  );
  return { stop: async () => (await started).stop() };
}

/** The sweep and the pause timers of a fork (#1286b): nothing to look for, a fork runs one child. */
export function idleLooks(clock: Clock): {
  readonly sweep: RecoverySweep;
  readonly timers: PauseTimers;
} {
  let isStopped = false;
  const stop = (): Promise<void> => {
    isStopped = true;
    return Promise.resolve();
  };
  const now = (): Date => clock.now();
  return {
    sweep: { stop, lastSweptAt: now, isStopped: () => isStopped },
    timers: { stop, lastTickAt: now, isStopped: () => isStopped },
  };
}
