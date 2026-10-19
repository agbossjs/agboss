import type { RunnableConfig } from "@langchain/core/runnables";
import { extractRunContext } from "../../../core/run-context.js";
import type { UsageRecord } from "../../../finops/usage.js";
import { slotOfDto, slotOfValue } from "../../analyse/scope.js";
import type { ScopeRecords } from "../records.js";
import type { ExecutionStateType } from "../state.js";
import type { BranchTicket, LaunchTicket } from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { readInput } from "../scope.js";
import type { ScheduledBranch } from "./branch-schedule.js";

/**
 * What one branch of a launch sees (#273): the scope at the launch — plus, in a per-item run, its
 * item as the latest single `XDto` (its `valueId` the list's: the run counts as reading the list) —
 * the visit and steps its ticket counted, the spend of its siblings that ended, and a signal that
 * the launch's `FailFast` abort and the execution's own cancel both stop.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isTicket = (value: unknown): value is BranchTicket =>
  isRecord(value) &&
  typeof value.index === "number" &&
  typeof value.node === "string" &&
  typeof value.nodeId === "string";

/** The branch a `Send` carries next to the state (LangGraph boundary: checked, not cast). */
export function branchTicketOf(input: object): BranchTicket {
  const ticket: unknown = Reflect.get(input, "branch");
  if (!isTicket(ticket)) throw new TypeError("a launch branch ran without its ticket");
  return ticket;
}

/** The `Send` input of one branch: the state at the launch and the branch's ticket. */
export interface BranchInput extends ExecutionStateType {
  readonly branch: BranchTicket;
}

export const branchInputOf = (state: ExecutionStateType, branch: BranchTicket): BranchInput => ({
  ...state,
  branch,
});

/** The scope with a per-item run's item as the latest single value of its class. */
function withItem(scope: ScopeRecords, launch: RuntimeLaunch, ticket: BranchTicket): ScopeRecords {
  const { items } = launch.launch;
  if (ticket.itemIndex === undefined || items === undefined) return scope;
  const { element } = items;
  const list = scope[slotOfValue(items)];
  if (typeof element !== "function" || list === undefined || !Array.isArray(list.value))
    return scope;
  const slot = slotOfDto(element);
  const value: unknown = (list.value as readonly unknown[])[ticket.itemIndex];
  const { valueId, producer, builtFrom } = list;
  return { ...scope, [slot]: { valueId, slot, producer, value, builtFrom } };
}

/** The state one branch runs on. */
export function branchStateOf(
  state: ExecutionStateType,
  launch: RuntimeLaunch,
  ticket: BranchTicket,
  spentBySiblings: readonly UsageRecord[],
): ExecutionStateType {
  return {
    ...state,
    scope: withItem(state.scope, launch, ticket),
    visits: { ...state.visits, [ticket.node]: ticket.visitNumber - 1 },
    steps: ticket.stepsBefore,
    usage: [...state.usage, ...spentBySiblings],
  };
}

/** The run's config with `signal` in place of the execution's: the call, its tools and the context. */
export function branchConfigOf(
  config: RunnableConfig | undefined,
  signal: AbortSignal,
  runId: string,
): RunnableConfig {
  const { run } = extractRunContext(config, runId);
  return { ...config, signal, configurable: { ...config?.configurable, run: { ...run, signal } } };
}

/** The launch a branch belongs to (the state's ticket and its graph launch). */
export interface BranchLaunch {
  readonly ticket: LaunchTicket;
  readonly launch: RuntimeLaunch;
}

/** The launch in flight and its graph launch; a branch without one is a framework error. */
export function branchLaunchOf(
  state: ExecutionStateType,
  launches: readonly RuntimeLaunch[],
): BranchLaunch {
  const ticket = state.launch;
  const launch = launches.find((candidate) => candidate.key === ticket?.key);
  if (ticket === null || launch === undefined)
    throw new TypeError("a launch branch ran without the launch in flight");
  return { ticket, launch };
}

/** Where a branch runs, as its scheduler is told about it. */
export interface ScheduledSite {
  readonly node: RuntimeNode;
  readonly state: ExecutionStateType;
  readonly ticket: BranchTicket;
  readonly owner: BranchLaunch;
  readonly live: { readonly spent: readonly UsageRecord[] };
  readonly graph: RuntimeGraph;
}

/** The branch as a test's scheduler sees it (#262 S33): what it runs and, when asked, what it reads. */
export function scheduledOf(site: ScheduledSite): ScheduledBranch {
  const { node, ticket, owner } = site;
  return {
    launchId: owner.ticket.launchId,
    index: ticket.index,
    nodeId: ticket.nodeId,
    component: node.component,
    input: () => {
      const view = branchStateOf(site.state, owner.launch, ticket, site.live.spent);
      return readInput(site.graph, node, view).fields;
    },
  };
}
