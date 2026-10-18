import { slotOfValue } from "../../analyse/scope.js";
import { NodeKind } from "../../ast.js";
import { idempotencyKeyOf } from "../../context/idempotency.js";
import { declarationOf } from "../../decorators/declaration.js";
import {
  failurePolicyOf,
  FailurePolicy,
  routesOf,
  spawnPolicyOf,
  SpawnPolicy,
  type AnyRouterRoute,
} from "../../decorators/router.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import type { ScopeRecords } from "../records.js";
import type { BranchTicket, LaunchTicket } from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * Which branches a launch dispatches (#273 S20, S23): each listed target once, in listed order —
 * copies of a repeated agent numbered from 1 (`critic-agent#1`, `critic-agent#2`) — or, per item,
 * the first `maxItems` items of the list the launching step wrote, in list order (the rest dropped
 * without an error, recorded); after a router, its `Always` targets and the `OnDemand` ones it
 * chose. Every branch of a launch is the same visit of its node (copies and items are told apart
 * by `copyNumber` and `itemIndex`); steps are counted here, in dispatch order, so they are the same
 * however the branches finish — and again after a resume.
 */

/** Where a launch is dispatched from: the launching step's visit and what it decided. */
export interface DispatchSite {
  readonly graph: RuntimeGraph;
  readonly launch: RuntimeLaunch;
  readonly launcher: RuntimeNode;
  readonly executionId: string;
  readonly visitNumber: number;
  /** The scope after the launching step's write (a per-item launch's list is in it). */
  readonly scope: ScopeRecords;
  /** Visits per node and the steps, the launching step's own visit included. */
  readonly visits: Readonly<Record<string, number>>;
  readonly steps: number;
  /** A router's `OnDemand` targets to launch (node ids); undefined for any other launcher. */
  readonly chosen?: readonly string[];
}

/** One branch before its counters: which node, which copy or item, its policy. */
interface Planned {
  readonly node: string;
  readonly nodeId: string;
  readonly copyNumber: number;
  readonly itemIndex?: number;
  readonly failure: FailurePolicy;
}

const routeOf = (launcher: RuntimeNode, node: string): AnyRouterRoute | undefined => {
  const { declaration } = launcher;
  if (declaration.kind !== NodeKind.Router) return undefined;
  return routesOf(declaration.options).find(
    (route) => declarationOf(route.target)?.options.name === node,
  );
};

/** Whether a listed target runs: always, unless a router left its `OnDemand` route out. */
function isLaunched(site: DispatchSite, node: string, route: AnyRouterRoute | undefined): boolean {
  const { declaration } = site.launcher;
  if (route === undefined || declaration.kind !== NodeKind.Router) return true;
  if (spawnPolicyOf(declaration.options, route) === SpawnPolicy.Always) return true;
  return site.chosen?.includes(node) === true;
}

function listedBranches(site: DispatchSite): readonly Planned[] {
  const { listed } = site.launch.launch;
  const seen = new Map<string, number>();
  return listed.flatMap((node): readonly Planned[] => {
    const copyNumber = (seen.get(node) ?? 0) + 1;
    seen.set(node, copyNumber);
    const route = routeOf(site.launcher, node);
    if (!isLaunched(site, node, route)) return [];
    const isRepeated = listed.filter((name) => name === node).length > 1;
    const failure = route === undefined ? FailurePolicy.FailFast : failurePolicyOf(route);
    const nodeId = isRepeated ? `${node}#${String(copyNumber)}` : node;
    return [{ node, nodeId, copyNumber, failure }];
  });
}

/** The items of a per-item launch: the list the launching step wrote. */
function itemsOf(site: DispatchSite): readonly unknown[] {
  const { items } = site.launch.launch;
  if (items === undefined) return [];
  const record = site.scope[slotOfValue(items)];
  return Array.isArray(record?.value) ? (record.value as readonly unknown[]) : [];
}

function itemBranches(site: DispatchSite, taken: number): readonly Planned[] {
  const [branch] = site.launch.launch.branches;
  if (branch === undefined) return [];
  return Array.from({ length: taken }, (_, itemIndex) => ({
    node: branch.node,
    nodeId: branch.node,
    copyNumber: 1,
    itemIndex,
    failure: FailurePolicy.FailFast,
  }));
}

/** Each planned branch's visit of its node (the launch's one) and the steps before it. */
function counted(site: DispatchSite, planned: readonly Planned[]): readonly BranchTicket[] {
  let steps = site.steps;
  return planned.map((branch, index) => {
    // every run of one launch is the same visit of its node: copies and items differ by number
    const visitNumber = (site.visits[branch.node] ?? 0) + 1;
    const stepsBefore = steps;
    if (site.graph.nodes.get(branch.node)?.kind === NodeKind.Agent) steps += 1;
    return { ...branch, index, visitNumber, stepsBefore };
  });
}

/** The launch's ticket: its id, its branches, how many items there were and were taken. */
export function dispatchOf(site: DispatchSite): LaunchTicket {
  const { items: list, listed, maxItems, maxConcurrency } = site.launch.launch;
  const isPerItem = list !== undefined;
  const items = isPerItem ? itemsOf(site).length : listed.length;
  const planned = isPerItem
    ? itemBranches(site, Math.min(items, maxItems ?? items))
    : listedBranches(site);
  const branches = counted(site, planned);
  const { executionId, visitNumber } = site;
  return {
    launchId: idempotencyKeyOf({ executionId, nodeId: site.launcher.id, visitNumber }),
    key: site.launch.key,
    launcher: site.launcher.id,
    visitNumber,
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    items,
    taken: branches.length,
    branches,
  };
}
