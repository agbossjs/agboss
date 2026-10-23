import { componentRecordsOf, type JoinKeySource } from "../flow/runtime/join-keys.js";
import {
  modelComponentRecordsOf,
  type ModelComponentSource,
} from "../flow/runtime/model-component-keys.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import { CassetteChange } from "./errors.js";
import type { Interaction } from "./vcr-file.js";

/**
 * What a cassette compares (#395 PR 4): the component behind each script key and its join keys —
 * the `promptHash` / `schemaHash` of `agboss describe --json`: every agent and model router, and
 * every other component that calls a model (#395 PR 5b) — model judges (their `reply` only),
 * guardrails, arbiters, compactions, reply interpreters and PII policies that detect with a model.
 */

/** A component's recorded identity: its `name` and, when the application knows them, its hashes. */
export interface ComponentHashes {
  readonly component: string;
  readonly promptHash?: string;
  readonly schemaHash?: string;
}

/** The hashes of the application's components, by script key (`agent:<name>`, …). */
export interface CassetteHashes {
  /** The component a key names and its current hashes. */
  of(key: string): ComponentHashes;
  /** Whether the application has the component (agents and model routers only are known). */
  knows(component: string): boolean;
}

/** The component of a script key: what follows its kind (`agent:support-agent` → `support-agent`). */
export const componentOfKey = (key: string): string => {
  const at = key.indexOf(":");
  return at < 0 ? key : key.slice(at + 1);
};

/** What a cassette's hashes are read from: one workflow's nodes and its other model components. */
export type CassetteHashSource = JoinKeySource & ModelComponentSource;

/** Every record of a workflow that has a hash: its nodes', then its other model components'. */
const recordsOf = (workflow: CassetteHashSource): [string, ComponentRecord][] => [
  ...componentRecordsOf(workflow),
  ...modelComponentRecordsOf(workflow).map((record): [string, ComponentRecord] => [
    record.name,
    record,
  ]),
];

/** The hashes of every model component of the workflows, by component name. */
export function cassetteHashesOf(workflows: readonly CassetteHashSource[]): CassetteHashes {
  const known = new Map<string, ComponentHashes>();
  for (const workflow of workflows) {
    for (const [name, record] of recordsOf(workflow)) {
      if (record.promptHash === undefined && record.schemaHash === undefined) continue;
      known.set(name, {
        component: name,
        ...(record.promptHash === undefined ? {} : { promptHash: record.promptHash }),
        ...(record.schemaHash === undefined ? {} : { schemaHash: record.schemaHash }),
      });
    }
  }
  return {
    of: (key) => known.get(componentOfKey(key)) ?? { component: componentOfKey(key) },
    knows: (component) => known.has(component),
  };
}

/** No hashes known: every component recorded by name only (a cassette outside an application). */
export const NO_HASHES: CassetteHashes = {
  of: (key) => ({ component: componentOfKey(key) }),
  knows: () => false,
};

/**
 * What changed in an interaction's component since it was recorded: none when the recording has no
 * hashes (a version 1 cassette, a component recorded by name only).
 */
export function changesOf(interaction: Interaction, hashes: CassetteHashes): CassetteChange[] {
  const { promptHash, schemaHash } = interaction;
  if (promptHash === undefined && schemaHash === undefined) return [];
  const component = interaction.component ?? componentOfKey(interaction.key);
  if (!hashes.knows(component)) return [CassetteChange.Removed];
  const current = hashes.of(interaction.key);
  return [
    ...(current.promptHash === promptHash ? [] : [CassetteChange.Prompt]),
    ...(current.schemaHash === schemaHash ? [] : [CassetteChange.Schema]),
  ];
}

/** One stale component of a cassette and what changed in it. */
export interface StaleComponent {
  readonly component: string;
  readonly changes: readonly CassetteChange[];
}

/** The components of the interactions that changed since they were recorded, each once. */
export function staleComponentsOf(
  interactions: readonly Interaction[],
  hashes: CassetteHashes,
): StaleComponent[] {
  const stale = new Map<string, readonly CassetteChange[]>();
  for (const interaction of interactions) {
    const component = interaction.component ?? componentOfKey(interaction.key);
    if (stale.has(component)) continue;
    const changes = changesOf(interaction, hashes);
    if (changes.length > 0) stale.set(component, changes);
  }
  return [...stale].map(([component, changes]) => ({ component, changes }));
}
