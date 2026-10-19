import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Class } from "../../../components/injection.js";
import { extractRunContext } from "../../../core/run-context.js";
import { totalCost, type UsageRecord } from "../../../finops/usage.js";
import type { ArbiterClass } from "../../ast.js";
import type { ExecutionLimits } from "../limits.js";
import type { ExecutionStateType } from "../state.js";
import type { ArbiterModel } from "./arbiter-model.js";
import type { ArbiterDeps } from "./arbiters.js";
import type { BranchLaunch } from "./branch-view.js";
import type { LaunchRegistry, LiveLaunch } from "./launch-registry.js";
import { pendingRecordsOf } from "./pending-records.js";
import { quorumMakerOf } from "./quorum-branch.js";
import type { BranchScheduler } from "./branch-schedule.js";

/**
 * What a branch of a quorum launch runs on (#279): its launch's entry in this process — a quorum's
 * rebuilt from the checkpoint's pending writes after a resume or a crash (S26) — and its arbiters:
 * code ones from the container, model ones on their model, the execution's budgets checked before
 * every model call.
 */

/** What arbiters run on: their instances from the container, their models. */
export interface BranchArbiters {
  readonly instanceOf: (arbiter: Class) => unknown;
  readonly modelOf?: (arbiter: ArbiterClass) => ArbiterModel | undefined;
}

/** A branch's part of the launch deps: the registry, the arbiters, the checkpointer. */
export interface BranchQuorumDeps {
  readonly registry: LaunchRegistry;
  /** A test's schedule of the branches (#262 S33): it sets the launch's slots; none in production. */
  readonly scheduler?: BranchScheduler;
  readonly arbiters?: BranchArbiters;
  /** Where a quorum's finished branches are read back from after a resume or a crash. */
  readonly checkpointer?: BaseCheckpointSaver;
}

/** Where a branch's arbiters run: its launch, its view of the state, what it spent so far. */
export interface ArbiterSite {
  readonly limits: ExecutionLimits;
  readonly arbiters?: BranchArbiters;
  readonly live: LiveLaunch;
  readonly view: ExecutionStateType;
  readonly services: readonly UsageRecord[];
  readonly nodeId: string;
}

/** The arbiters of a branch's quorum, the budgets checked before each model call. */
export function arbiterDepsFor(site: ArbiterSite): ArbiterDeps {
  const { budgets } = site.limits;
  const parts = site.arbiters;
  return {
    instanceOf: parts?.instanceOf ?? ((): undefined => undefined),
    ...(parts?.modelOf === undefined ? {} : { modelOf: parts.modelOf }),
    signal: site.live.controller.signal,
    beforeModelCall: async (spent) => {
      await budgets.refresh();
      const path = [...site.view.path, site.nodeId];
      budgets.check(totalCost([...site.view.usage, ...site.services, ...spent]), path);
    },
  };
}

/** The launch's entry in this process; a quorum's rebuilt from the checkpoint (#279 S26). */
export function liveLaunchOf(
  owner: BranchLaunch,
  state: ExecutionStateType,
  config: RunnableConfig | undefined,
  deps: BranchQuorumDeps,
): LiveLaunch {
  const { launchId, maxConcurrency, branches } = owner.ticket;
  const { clock } = extractRunContext(config, state.runId);
  const pending = () => pendingRecordsOf(deps.checkpointer, config, launchId);
  const makeQuorum = quorumMakerOf({ launch: owner.launch, ticket: owner.ticket, clock, pending });
  const declared = maxConcurrency ?? Math.max(branches.length, 1);
  const size = deps.scheduler?.slotsOf(declared) ?? declared;
  return deps.registry.liveOf(launchId, size, makeQuorum);
}
