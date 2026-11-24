import type { Class } from "../components/injection.js";
import { arbiterOf, isDeclarativeArbiter } from "../flow/decorators/arbiter.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { DecidedBy } from "../flow/decorators/router.js";
import { QuorumKind, type ArbiterClass, type Quorum } from "../flow/ast.js";
import {
  EdgeKind,
  type FlowEdge,
  type FlowLaunch,
  type ValueWrite,
} from "../flow/analyse/flow-graph.js";
import { calendarNameOf } from "../calendar/calendar-source.js";
import { isWorkingDuration } from "../units/index.js";
import { amountOf } from "../units/working-time.js";
import { shapeLabel } from "../flow/analyse/labels.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { arbiterPromptHashOf } from "../flow/runtime/model-component-keys.js";
import type { ModelArbiterUse } from "../flow/runtime/launch/runtime-launch.js";

/**
 * The flow of a workflow as data (#268 S92 / S93, `agboss describe --json`): every edge as the
 * analyser built it — `.to…` steps, a `.toOneOf([…])` branch cases, `.onRoute(…)` routes, launches and joins with
 * what each puts on the path —, the `.onError` table, and
 * every launch with its quorum and arbiter tree, each arbiter with its hashes.
 */

/** One value an edge puts on the path: its shape. */
export interface EdgeValueSnapshot {
  readonly value: string;
  /** Written by a `.toOneOf([…])` branch: the switch chose the edge by it. */
  readonly isCase?: true;
}

/** One edge of the flow. */
export interface EdgeSnapshot {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly writes: readonly EdgeValueSnapshot[];
  /** The error class an `error` / `join-error` edge takes. */
  readonly error?: string;
  /** A join edge of `.joinQuorumGroups(…)`: the group it continues, its targets as listed. */
  readonly group?: readonly string[];
}

/** One row of the `.onError` table: where, which class, the side path's first node. */
export interface ErrorHandlerSnapshot {
  readonly at: string;
  readonly error: string;
  readonly by: string;
  /** `error` for a step's `.onError(…)`, `join-error` for a join's `.onError(…)`. */
  readonly kind: EdgeKind;
}

/** One arbiter of a launch with its join keys. */
export interface ArbiterSnapshot {
  readonly name: string;
  readonly kind: ComponentKind;
  readonly decidedBy: DecidedBy;
  readonly model?: string;
  readonly promptHash: string | undefined;
  readonly schemaHash: undefined;
}

/** A quorum as written: `{ min, max, deadline }`, or its groups. */
export interface QuorumSnapshot {
  readonly kind: QuorumKind;
  readonly min?: number;
  readonly max?: number;
  /** In milliseconds; for working time (`isDeadlineWorking`) in its own unit: working ms, or working days. */
  readonly deadline?: number;
  /** `true` when `deadline` is working time (#1306), counted by `calendar`. */
  readonly isDeadlineWorking?: true;
  /** The `@WorkingCalendar` class that counts a working `deadline`. */
  readonly calendar?: string;
  readonly groups?: readonly { readonly targets: readonly string[]; readonly priority?: number }[];
}

/** One launch: who launches what, how wide, its quorum and its arbiter (`.arbitratedBy`). */
export interface LaunchSnapshot {
  readonly launcher: string;
  readonly targets: readonly string[];
  readonly isPerItem: boolean;
  readonly maxConcurrency?: number;
  readonly maxItems?: number;
  readonly takeFirst?: number;
  readonly quorum?: QuorumSnapshot;
  /** The launch's one `.arbitratedBy(A)` arbiter. */
  readonly arbitratedBy?: ArbiterSnapshot;
}

const nameOf = (component: Class): string =>
  declarationOf(component)?.options.name ?? component.name;

const valueOf = (write: ValueWrite): EdgeValueSnapshot => ({
  value: shapeLabel(write.shape),
  ...(write.isCase ? { isCase: true } : {}),
});

const edgeOf = (edge: FlowEdge): EdgeSnapshot => ({
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
  writes: edge.writes.map(valueOf),
  ...(edge.error === undefined ? {} : { error: edge.error.name }),
  ...(edge.join?.group === undefined ? {} : { group: edge.join.group.targets }),
});

/** Every edge of the graph, in the analyser's canonical order. */
export const edgesOf = (graph: RuntimeGraph): readonly EdgeSnapshot[] =>
  graph.analysis.graph.edges.map(edgeOf);

/** The side paths: every `error` and `join-error` edge. */
export const errorHandlersOf = (graph: RuntimeGraph): readonly ErrorHandlerSnapshot[] =>
  graph.analysis.graph.edges.flatMap((edge) =>
    edge.error === undefined
      ? []
      : [{ at: edge.from, error: edge.error.name, by: edge.to, kind: edge.kind }],
  );

/** An arbiter with its hashes: a model one's prompt and criteria. */
function arbiterSnapshotOf(
  arbiter: ArbiterClass,
  uses: readonly ModelArbiterUse[],
): ArbiterSnapshot {
  const options = arbiterOf(arbiter)?.options;
  const name = options?.name ?? arbiter.name;
  const base = { name, kind: ComponentKind.Arbiter, schemaHash: undefined };
  if (options === undefined || !isDeclarativeArbiter(options))
    return { ...base, decidedBy: DecidedBy.Code, promptHash: undefined };
  return {
    ...base,
    decidedBy: DecidedBy.Model,
    model: options.model,
    promptHash: arbiterPromptHashOf(arbiter, uses),
  };
}

/** The quorum's deadline, flagged when it is working time, with the calendar that counts it. */
function deadlineOf(
  quorum: Quorum,
): Pick<QuorumSnapshot, "deadline" | "isDeadlineWorking" | "calendar"> {
  const { deadline, calendar } = quorum;
  if (deadline === undefined) return {};
  return {
    deadline: amountOf(deadline),
    ...(isWorkingDuration(deadline) ? { isDeadlineWorking: true as const } : {}),
    ...(calendar === undefined ? {} : { calendar: calendarNameOf(calendar) }),
  };
}

function quorumOf(quorum: Quorum): QuorumSnapshot {
  const deadline = deadlineOf(quorum);
  if (quorum.kind === QuorumKind.Count)
    return {
      kind: quorum.kind,
      min: quorum.min,
      max: quorum.max ?? quorum.min,
      ...deadline,
    };
  const groups = quorum.groups.map((group) => ({
    targets: group.targets.map(nameOf),
    ...(group.priority === undefined ? {} : { priority: group.priority }),
  }));
  return { kind: quorum.kind, groups, ...deadline };
}

const launchOf = (
  launch: FlowLaunch,
  quorum: Quorum | undefined,
  uses: readonly ModelArbiterUse[],
): LaunchSnapshot => ({
  launcher: launch.launcher,
  targets: launch.listed,
  isPerItem: launch.items !== undefined,
  ...(launch.maxConcurrency === undefined ? {} : { maxConcurrency: launch.maxConcurrency }),
  ...(launch.maxItems === undefined ? {} : { maxItems: launch.maxItems }),
  ...(launch.takeFirst === undefined ? {} : { takeFirst: launch.takeFirst }),
  ...(quorum === undefined ? {} : { quorum: quorumOf(quorum) }),
  ...(launch.arbitratedBy === undefined
    ? {}
    : { arbitratedBy: arbiterSnapshotOf(launch.arbitratedBy, uses) }),
});

/** Every launch of the graph. */
export const launchesOfGraph = (
  graph: RuntimeGraph,
  uses: readonly ModelArbiterUse[] = [],
): readonly LaunchSnapshot[] =>
  graph.launches.map((launch) => launchOf(launch.launch, launch.quorum, uses));
