import { isGraphInterrupt } from "@langchain/langgraph";
import { errorRecordOf } from "../../core/error-record.js";
import { extractRunContext } from "../../core/run-context.js";
import type { FlowEdge } from "../analyse/flow-graph.js";
import { runInFrame } from "../context/frame.js";
import { errorHandlerOf, type RuntimeGraph, type RuntimeNode } from "./graph-model.js";
import { checkVisit, isWorkingNode, type ExecutionLimits } from "./limits.js";
import {
  recordsOf,
  reportingOf,
  unrecordedSpendOf,
  type Reported,
  type GraphNode,
  type NodeOutcome,
  type NodeRunner,
} from "./node-runner.js";
import { compensationsOfVisit } from "../compensation.js";
import type { CompensationParts } from "./compensation/registry.js";
import { OutputInvalidError } from "./errors.js";
import { RouterDecisionError } from "./router-error.js";
import { handedOverReason } from "../../app/handed-over.js";
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
import { succeededStepsOf, visitStepsOf, type VisitAt, type VisitSite } from "./visit-step.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import { launchEdgeOf, launchFor, launchTicketOf, nextOfLaunch } from "./launch/launch-exit.js";
import { reportTruncation } from "./launch/launch-report.js";
import type { LaunchTicket } from "./launch/records.js";
import type { RuntimeLaunch } from "./launch/runtime-launch.js";
import { readInput } from "./scope.js";
import { handledErrorOf, recordOfNode } from "./workflow-keys.js";
import type { TreeSlotRegistry } from "./launch/launch-registry.js";

/**
 * A node's visit (#272 → Runtime): limits checked before an agent or a router runs, the node run,
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

function visited(node: RuntimeNode, isStep: boolean): ExecutionStateUpdate {
  return { path: [node.id], visits: { [node.id]: 1 }, steps: isStep ? 1 : 0 };
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
    ...(launched === undefined ? {} : { launch: launched.ticket }),
    ...recordsOf(outcome),
    ...(outcome.finish === undefined ? {} : { finish: node.id, output: outcome.finish.output }),
    stepRecords: succeededStepsOf({ ...at, node, state, endedAt: at.now }, outcome),
  };
  return { update, write, ...(launched === undefined ? {} : { launched }) };
}

/** A failure the node's `.onError` takes: kept as a record, the side path next; else rethrown. */
function caught(
  deps: VisitDeps,
  visit: VisitSite,
  error: unknown,
  { ranAsStep, reported }: { readonly ranAsStep: boolean; readonly reported: Reported },
  signal: AbortSignal | undefined,
): ExecutionStateUpdate {
  const { node } = visit;
  if (isGraphInterrupt(error)) throw error;
  // a lost lease or an interruption is no failure of the step: another instance goes on (#265)
  const handedOver = handedOverReason(signal);
  if (handedOver !== undefined) throw handedOver;
  const record = errorRecordOf(error);
  const handler = errorHandlerOf(node.exits, record);
  if (handler === undefined) throw error;
  const usage = [...unrecordedSpendOf(error), ...reported.usage];
  return {
    ...visited(node, ranAsStep),
    lastError: record,
    next: handler.to,
    usage,
    stepRecords: visitStepsOf(visit, { usage, error: record }),
    children: [...reported.children],
    piiTokens: reported.piiTokens,
    handledErrors: [handledErrorOf(deps, record, node.id, handler.to)],
  };
}

/**
 * Wraps a node's runner with the execution's bookkeeping; the runner runs in the step's frame (what
 * an injected `ExecutionContext` reads), closed when it returns (#280 S18).
 */
export function visitNode(node: RuntimeNode, runner: NodeRunner, deps: VisitDeps): GraphNode {
  return async (state, config) => {
    let ranAsStep = false;
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
      // a slot of the tree first (#264), then the limits: the counters as they are when it works
      const outcome = await inTreeSlot(slot, async () => {
        if (isWorkingNode(node)) {
          await checkVisit(state, node, deps.limits, deps.workflow, frame.step.component);
          ranAsStep = true;
        }
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
      const own = await compensationsOfVisit({ ...failed, failure: error });
      // a failed child's undone entries first (#340): the visit's own close after them
      const compensations = [...reported.compensations, ...(own.compensations ?? [])];
      return { ...handled, ...(compensations.length === 0 ? {} : { compensations }), ...kept };
    }
  };
}
