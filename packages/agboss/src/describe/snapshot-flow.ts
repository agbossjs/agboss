import type { Class } from "../components/injection.js";
import { normalisePromptText } from "../components/prompt-render.js";
import { arbiterOf, isCodeArbiter } from "../flow/decorators/arbiter.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { DecidedBy } from "../flow/decorators/router.js";
import { QuorumKind, type ArbiterClass, type Quorum } from "../flow/ast.js";
import {
  EdgeKind,
  type FlowEdge,
  type FlowLaunch,
  type ValueWrite,
} from "../flow/analyse/flow-graph.js";
import { shapeLabel } from "../flow/analyse/labels.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { versionOf } from "../terns/index.js";

/**
 * The flow of a workflow as data (#268 S92 / S93, `agboss describe --json`): every edge as the
 * analyser built it — `.to…` steps, `caseOf(…)` cases, `route(…)` routes, launches and joins with
 * what each puts on the path and what it is `about` —, the `.onError` / `.onJoinError` table, and
 * every launch with its quorum and arbiter tree, each arbiter with its hashes.
 */

/** One value an edge puts on the path: its shape, and what it is about. */
export interface EdgeValueSnapshot {
  readonly value: string;
  readonly about?: readonly string[];
  /** Written by `caseOf(…)`: the switch chose the edge by it. */
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
  /** A join edge of `.joinQuorumGroups(…)`: the group it continues, its agents as listed. */
  readonly group?: readonly string[];
}

/** One row of the `.onError` / `.onJoinError` table: where, which class, the side path's first node. */
export interface ErrorHandlerSnapshot {
  readonly at: string;
  readonly error: string;
  readonly by: string;
  /** `error` for `.onError(…)`, `join-error` for `.onJoinError(…)`. */
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
  /** In milliseconds. */
  readonly deadline?: number;
  readonly groups?: readonly { readonly agents: readonly string[]; readonly priority?: number }[];
}

/** One launch: who launches what, how wide, its quorum and its arbiters (`.acceptedBy`, `anyOf`). */
export interface LaunchSnapshot {
  readonly launcher: string;
  readonly targets: readonly string[];
  readonly isPerItem: boolean;
  readonly maxConcurrency?: number;
  readonly maxItems?: number;
  readonly quorum?: QuorumSnapshot;
  /** Each `.acceptedBy(…)` in path order (an AND); its arbiters an `anyOf` (the first that accepts). */
  readonly acceptedBy: readonly (readonly ArbiterSnapshot[])[];
}

const nameOf = (component: Class): string =>
  declarationOf(component)?.options.name ?? component.name;

const valueOf = (write: ValueWrite): EdgeValueSnapshot => ({
  value: shapeLabel(write.shape),
  ...(write.about === undefined ? {} : { about: write.about.map((dto) => dto.name) }),
  ...(write.isCase ? { isCase: true } : {}),
});

const edgeOf = (edge: FlowEdge): EdgeSnapshot => ({
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
  writes: edge.writes.map(valueOf),
  ...(edge.error === undefined ? {} : { error: edge.error.name }),
  ...(edge.join?.group === undefined ? {} : { group: edge.join.group.agents }),
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
function arbiterSnapshotOf(arbiter: ArbiterClass): ArbiterSnapshot {
  const options = arbiterOf(arbiter)?.options;
  const name = options?.name ?? arbiter.name;
  const base = { name, kind: ComponentKind.Arbiter, schemaHash: undefined };
  if (options === undefined || isCodeArbiter(options))
    return { ...base, decidedBy: DecidedBy.Code, promptHash: undefined };
  const criteria = options.criteria.map(({ agent, prompt }) => ({
    agent: nameOf(agent),
    prompt: normalisePromptText(prompt),
  }));
  const prompt = { prompt: normalisePromptText(options.prompt), criteria };
  return {
    ...base,
    decidedBy: DecidedBy.Model,
    model: options.model,
    promptHash: versionOf(prompt),
  };
}

function quorumOf(quorum: Quorum): QuorumSnapshot {
  const deadline = quorum.deadline === undefined ? {} : { deadline: quorum.deadline };
  if (quorum.kind === QuorumKind.Count)
    return {
      kind: quorum.kind,
      min: quorum.min,
      max: quorum.max ?? quorum.min,
      ...deadline,
    };
  const groups = quorum.groups.map((group) => ({
    agents: group.agents.map(nameOf),
    ...(group.priority === undefined ? {} : { priority: group.priority }),
  }));
  return { kind: quorum.kind, groups, ...deadline };
}

const launchOf = (launch: FlowLaunch, quorum: Quorum | undefined): LaunchSnapshot => ({
  launcher: launch.launcher,
  targets: launch.listed,
  isPerItem: launch.items !== undefined,
  ...(launch.maxConcurrency === undefined ? {} : { maxConcurrency: launch.maxConcurrency }),
  ...(launch.maxItems === undefined ? {} : { maxItems: launch.maxItems }),
  ...(quorum === undefined ? {} : { quorum: quorumOf(quorum) }),
  acceptedBy: (launch.acceptedBy ?? []).map((step) => step.arbiters.map(arbiterSnapshotOf)),
});

/** Every launch of the graph. */
export const launchesOfGraph = (graph: RuntimeGraph): readonly LaunchSnapshot[] =>
  graph.launches.map((launch) => launchOf(launch.launch, launch.quorum));
