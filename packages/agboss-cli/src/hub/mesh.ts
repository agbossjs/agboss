import {
  recordsHealthOf,
  suitesHealthOf,
  type RecordsHealth,
  type SuiteHealth,
} from "./derived-health.js";
import type {
  DescribedApplication,
  DescribedChannel,
  DescribedWorkflow,
  HubInputs,
} from "./hub-inputs.js";
import { crystallizationRadarOf, type RadarStep } from "./crystallization-radar.js";
import { executionTreesOf, type ExecutionTree } from "./execution-trees.js";
import {
  declaredFederationOf,
  unstableReachOf,
  type DeclaredEdge,
  type FederationView,
} from "./federation-view.js";
import { observedCallsOf, observedEdgesOf, type ObservedEdge } from "./observed-calls.js";

/**
 * The mesh the Hub draws (#401 PR 3): every application its inputs name — described by a snapshot,
 * or only seen in records, eval runs, calls or as a declared contract's producer (#401 PR 7) —, the observed edges between them, and each one's
 * derived health. Applications are known by name: the records name them so (#398 Q3: no tenant
 * across organisations), and a snapshot's version is shown beside it.
 */

/** One application of the mesh. */
export interface MeshApplication {
  readonly name: string;
  /** The versions it was seen in: its snapshots', then its records' and runs'. */
  readonly versions: readonly string[];
  /** The newest snapshot's file; undefined for an application no snapshot describes. */
  readonly file?: string;
  readonly workflows: readonly DescribedWorkflow[];
  readonly channels: readonly DescribedChannel[];
  /** Its kept executions' health; undefined without any. */
  readonly records?: RecordsHealth;
  /** The latest run of each of its suites. */
  readonly suites: readonly SuiteHealth[];
}

/** What the Hub shows. */
export interface HubMesh {
  readonly applications: readonly MeshApplication[];
  readonly edges: readonly ObservedEdge[];
  /** The execution trees that cross applications (#401 PR 4). */
  readonly trees: readonly ExecutionTree[];
  /** The model steps ranked for turning into code (#401 PR 5). */
  readonly radar: readonly RadarStep[];
  /** Declared edges, the federation's problems and their blast radius (#401 PR 7). */
  readonly federation: FederationView;
  readonly inputs: {
    readonly describe: number;
    readonly evalRuns: number;
    readonly records: number;
  };
}

/** `1.10.0` after `1.9.0`: dotted numbers compared as numbers, the rest as text. */
export const compareVersions = (left: string, right: string): number =>
  left.localeCompare(right, "en", { numeric: true });

/** Its newest snapshot, by version. */
const newestOf = (snapshots: readonly DescribedApplication[]): DescribedApplication | undefined =>
  [...snapshots].sort((left, right) => compareVersions(left.version, right.version)).at(-1);

function namesOf(
  inputs: HubInputs,
  edges: readonly ObservedEdge[],
  declared: readonly DeclaredEdge[],
): string[] {
  const names = [
    ...declared.flatMap((edge) => [edge.from, edge.to]),
    ...inputs.applications.map((application) => application.name),
    ...inputs.records.map(({ record }) => record.application.name),
    ...inputs.evalRuns.map(({ report }) => report.application.name),
    ...edges.flatMap((edge) => [edge.from, edge.to]),
  ];
  return [...new Set(names)].sort();
}

function applicationOf(name: string, inputs: HubInputs): MeshApplication {
  const snapshots = inputs.applications.filter((application) => application.name === name);
  const records = inputs.records
    .filter(({ record }) => record.application.name === name)
    .map(({ record }) => record);
  const runs = inputs.evalRuns.filter(({ report }) => report.application.name === name);
  const newest = newestOf(snapshots);
  const versions = [
    ...snapshots.map((snapshot) => snapshot.version).sort(compareVersions),
    ...records.map((record) => record.application.version),
    ...runs.map(({ report }) => report.application.version),
  ];
  return {
    name,
    versions: [...new Set(versions)],
    ...(newest === undefined ? {} : { file: newest.file }),
    workflows: newest?.workflows ?? [],
    channels: newest?.channels ?? [],
    ...(records.length === 0 ? {} : { records: recordsHealthOf(records) }),
    suites: suitesHealthOf(runs),
  };
}

/** The mesh the inputs make. */
export function meshOf(inputs: HubInputs): HubMesh {
  const edges = observedEdgesOf(observedCallsOf(inputs.records));
  const described = [...new Set(inputs.applications.map((application) => application.name))];
  const newest = described.flatMap((name) => {
    const snapshot = newestOf(inputs.applications.filter((each) => each.name === name));
    return snapshot === undefined ? [] : [snapshot];
  });
  const declared = declaredFederationOf(newest);
  const names = namesOf(inputs, edges, declared.declaredEdges);
  const applications = names.map((name) => applicationOf(name, inputs));
  const suitesOf = (name: string) =>
    applications.find((application) => application.name === name)?.suites ?? [];
  const federation: FederationView = {
    ...declared,
    unstableReach: unstableReachOf(suitesOf, names, declared.declaredEdges, edges),
  };
  return {
    applications,
    edges,
    trees: executionTreesOf(inputs.records),
    radar: crystallizationRadarOf(inputs.records, suitesOf),
    federation,
    inputs: {
      describe: inputs.applications.length,
      evalRuns: inputs.evalRuns.length,
      records: inputs.records.length,
    },
  };
}
