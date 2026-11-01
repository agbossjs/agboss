import { extractRunContext } from "../../core/run-context.js";
import type { FlowEdge } from "../analyse/flow-graph.js";
import { runInFrame } from "../context/frame.js";
import type { RuntimeGraph, RuntimeNode } from "./graph-model.js";
import { checkVisit, isWorkingNode, sidePathAfter, type ExecutionLimits } from "./limits.js";
import {
  recordsOf,
  reportingOf,
  type GraphNode,
  type NodeOutcome,
  type NodeRunner,
} from "./node-runner.js";
import {
  compensationsOfHeldVisit,
  compensationsOfVisit,
  type CompensationEntry,
  type HeldUndo,
} from "../compensation.js";
import type { CompensationParts } from "./compensation/registry.js";
import type { Class } from "../../components/injection.js";
import type { StepEntries } from "./step-entries.js";
import { LimitExceededError } from "../../graph/limits.js";
import type { Clock } from "../../infrastructure/clock.js";
import { OutputInvalidError } from "./errors.js";
import { RouterDecisionError } from "./router-error.js";
import { reportOutdating } from "./outdating-report.js";
import type { RuntimeProvenance } from "./provenance.js";
import {
  startedVersionOf,
  stepFrameOf,
  visitNumberOf,
  type StepFrameDeps,
  inTreeSlot,
} from "./step-frame.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";
import { visitWrite, type VisitWrite } from "./visit-write.js";
import { succeededStepsOf, type VisitAt } from "./visit-step.js";
import { caught, visited } from "./visit-failure.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import { launchEdgeOf, launchFor, launchTicketOf, nextOfLaunch } from "./launch/launch-exit.js";
import { reportTruncation } from "./launch/launch-report.js";
import type { LaunchTicket } from "./launch/records.js";
import type { RuntimeLaunch } from "./launch/runtime-launch.js";
import { readInput } from "./scope.js";
import { recordOfNode } from "./workflow-keys.js";
import type { TreeSlotRegistry } from "./launch/launch-registry.js";

/**
 * A node's visit (#272 → Runtime): limits checked before it runs (`checkVisit`), the node run,
 * its way out chosen — the router's route, the `switch` case of its value's class, its one next step,
 * or the end at a finish — and its value written to the scope on that edge, outdating what it makes
 * stale (#271: one observer event and trace entry per cascade). A failure goes to the
 * node's most specific `.onError` handler as a plain record in state (it holds after a resume);
 * without one the execution fails with the error as it is.
 */

export interface VisitDeps extends StepFrameDeps {
  readonly limits: ExecutionLimits;
  /** What values are built from (#271). */
  readonly provenance: RuntimeProvenance;
  /** The graph: what a launch dispatches (#273). */
  readonly graph: RuntimeGraph;
  readonly observer?: ExecutionObserverManager;
  /** The trees' concurrency caps of this pass (#264): every step takes a slot of its tree. */
  readonly slots?: TreeSlotRegistry;
  /** The instance's undo bound and registry (#340); absent = the default bound, no registry. */
  readonly compensation?: CompensationParts | undefined;
  /** Where an undo action comes from (#675: the owed undo of a held-back visit), and the running steps. */
  readonly container: { readonly get: <T>(token: Class<T>) => T };
  readonly stepEntries?: StepEntries | undefined;
}

/** A failed visit's own entries: a held-back undo action's owed undo run (#675), else its close. */
function failedCompensations(
  site: Parameters<typeof compensationsOfVisit>[0],
  deps: VisitDeps,
  { isHeldBack, clock }: { readonly isHeldBack: boolean; readonly clock: Clock },
): ReturnType<typeof compensationsOfHeldVisit> {
  return isHeldBack
    ? compensationsOfHeldVisit({ ...site, clock, deps })
    : compensationsOfVisit(site);
}

/**
 * A handled failure's update with its entries — a failed child's undone ones first (#340), the
 * visit's own after them — and the owed undo's spend after the visit's own (#675).
 */
function withOwnCompensations(
  handled: ExecutionStateUpdate,
  childEntries: readonly CompensationEntry[],
  own: HeldUndo,
): ExecutionStateUpdate {
  const compensations = [...childEntries, ...(own.compensations ?? [])];
  const visitUsage = Array.isArray(handled.usage) ? handled.usage : [];
  const usage = [...visitUsage, ...(own.usage ?? [])];
  return { ...handled, usage, ...(compensations.length === 0 ? {} : { compensations }) };
}

/** The edge a visit leaves by; `undefined` at a finish (the execution ends). */
function exitOf(
  node: RuntimeNode,
  state: ExecutionStateType,
  outcome: NodeOutcome,
  deps: VisitDeps,
): FlowEdge | undefined {
  const { exits } = node;
  if (outcome.route !== undefined) {
    const route = exits.routes.get(outcome.route);
    if (route !== undefined) return route;
    const visit = { nodeId: node.id, visitNumber: visitNumberOf(node, state) };
    const step = { ...visit, component: recordOfNode(deps, node.id) };
    const reason = `"${outcome.route}" is not one of its routes`;
    throw new RouterDecisionError(step, reason, outcome.usage ?? []);
  }
  if (exits.cases.size > 0) {
    const variant = outcome.value?.variant ?? "";
    const branch = exits.cases.get(variant);
    if (branch !== undefined) return branch;
    throw new OutputInvalidError(
      `${node.id} gave ${variant || "no class"}, which its switch has no caseOf(…) for`,
    );
  }
  return exits.next;
}

/** A launch a visit took: its graph launch and the ticket of its branches (#273). */
interface Launched {
  readonly launch: RuntimeLaunch;
  readonly ticket: LaunchTicket;
}

/** A visit that succeeded: its bookkeeping, its way out and what its write did to the scope. */
interface Succeeded {
  readonly update: ExecutionStateUpdate;
  readonly write: VisitWrite;
  readonly launched?: Launched;
}

/** The launch a visit takes, with the ticket of its branches; none for a visit that launches nothing. */
function launchedBy(
  launch: RuntimeLaunch | undefined,
  node: RuntimeNode,
  outcome: NodeOutcome,
  site: {
    readonly state: ExecutionStateType;
    readonly deps: VisitDeps;
    readonly executionId: string;
    readonly now: Date;
  },
  write: VisitWrite,
): Launched | undefined {
  if (launch === undefined) return undefined;
  const { state, deps, executionId, now } = site;
  const scope = write.scope ?? state.scope;
  const visit = { graph: deps.graph, node, state, outcome, executionId, scope, now };
  return { launch, ticket: launchTicketOf(visit, launch) };
}

function succeeded(
  node: RuntimeNode,
  state: ExecutionStateType,
  outcome: NodeOutcome,
  deps: VisitDeps,
  at: VisitAt,
): Succeeded {
  const launch = launchFor(node, outcome);
  const exit = launch === undefined ? exitOf(node, state, outcome, deps) : launchEdgeOf(launch);
  const write = visitWrite(node, state, exit, outcome, deps.provenance);
  const launched = launchedBy(launch, node, outcome, { state, deps, ...at }, write);
  const next =
    launched === undefined ? (exit?.to ?? "") : nextOfLaunch(launched.launch, launched.ticket);
  const update = {
    ...visited(node, isWorkingNode(node)),
    ...write.update,
    next,
    ...sidePathAfter(state, node, launched === undefined ? next : undefined),
    ...(launched === undefined ? {} : { launch: launched.ticket }),
    ...recordsOf(outcome),
    ...(outcome.finish === undefined ? {} : { finish: node.id, output: outcome.finish.output }),
    stepRecords: succeededStepsOf({ ...at, node, state, endedAt: at.now }, outcome),
  };
  return { update, write, ...(launched === undefined ? {} : { launched }) };
}

/**
 * Wraps a node's runner with the execution's bookkeeping; the runner runs in the step's frame (what
 * an injected `ExecutionContext` reads), closed when it returns (#280 S18).
 */
export function visitNode(node: RuntimeNode, runner: NodeRunner, deps: VisitDeps): GraphNode {
  return async (state, config) => {
    let ranAsStep = false;
    // whether the visit's limits passed (#675): a limit thrown before held it back
    const limitsChecked = { isDone: false };
    const kept = { startedVersion: startedVersionOf(state, deps.workflow) };
    // what the step's code paid services through `SpendRecorder` (#280 S43), its children (#263)
    const { reported, services } = reportingOf(deps.limits, node, state.path);
    const frame = {
      ...stepFrameOf(node, state, config, deps),
      services: { ...services, input: () => readInput(deps.graph, node, state).fields },
    };
    const { clock } = extractRunContext(config, state.runId);
    // an undoable action, its committer, its undo or a finish (#340): what it writes of them
    const startedAt = clock.now();
    const undoables = { node, entries: state.compensations, frame, startedAt };
    const parts = { parts: deps.compensation };
    try {
      const slot = { slots: deps.slots, graph: deps.graph, node, state, config, ...frame };
      // a slot of the tree first (#264), then the limits (#634: every node that can spend)
      const outcome = await inTreeSlot(slot, async () => {
        ranAsStep = await checkVisit(state, node, deps.limits, deps.workflow, frame.step.component);
        limitsChecked.isDone = true;
        return runInFrame(frame, () => runner(state, config));
      });
      const spent = { ...outcome, usage: [...(outcome.usage ?? []), ...reported.usage] };
      const at = { executionId: frame.execution.executionId, now: clock.now(), frame, startedAt };
      const { update, write, launched } = succeeded(node, state, spent, deps, at);
      const outdatedSoFar = [...state.outdatedValues, ...write.outdated];
      const site = { observer: deps.observer, config, ...frame, outdatedSoFar };
      await reportOutdating(write.cascades, site);
      if (launched !== undefined) {
        const reportSite = { observer: deps.observer, config, frame };
        await reportTruncation(reportSite, launched.ticket, launched.launch.launch.maxItems);
      }
      const after = { ...undoables, ...parts, scope: write.scope ?? state.scope, endedAt: at.now };
      const compensations = await compensationsOfVisit(after);
      return { ...update, children: [...reported.children], ...compensations, ...kept };
    } catch (error) {
      const visit = { frame, node, state, startedAt, endedAt: clock.now() };
      const handled = caught(deps, visit, error, { ranAsStep, reported }, config?.signal);
      const failed = { ...undoables, ...parts, scope: state.scope, endedAt: clock.now() };
      // #675: a limit thrown before the node ran held the visit back — it ran nothing
      const isHeldBack = !limitsChecked.isDone && error instanceof LimitExceededError;
      const site = { ...failed, failure: error };
      const own = await failedCompensations(site, deps, { isHeldBack, clock });
      return { ...withOwnCompensations(handled, reported.compensations, own), ...kept };
    }
  };
}
