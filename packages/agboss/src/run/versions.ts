import { compactionPromptTexts } from "../prompts/compaction.js";
import type { AssembledCompactions } from "../compaction/assembly.js";
import { compactionSnapshot } from "../compaction/snapshot.js";
import { ragPromptTexts } from "../prompts/rag.js";
import { routerLaunchPromptTexts } from "../prompts/router-launch.js";
import { arbiterPromptTexts } from "../prompts/arbiter.js";
import { guardrailPromptTexts } from "../prompts/guardrail.js";
import { arbiterClassesOf, modelArbitersOf } from "../flow/runtime/launch/runtime-launch.js";
import { arbiterOf, isCodeArbiter } from "../flow/decorators/arbiter.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { routerPromptTexts } from "../routers/index.js";
import { versionOf } from "../terns/index.js";
import { byComponentName, flowLines } from "../flow/print.js";
import type { AgentExecutionDeps } from "./types.js";

import { stripFunctions } from "./strip-functions.js";
import type { Class } from "../components/injection.js";
import { childClassesOf } from "../flow/analyse/child-workflow.js";
import {
  agentFramePromptTexts,
  elementFingerprintsOf,
  type FingerprintDeps,
} from "./fingerprints.js";
import { normalisePromptText, promptTextOf } from "../components/prompt-render.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";
import {
  isModelGuardrail,
  modelGuardrailsOf,
  type LoadedGuardrail,
  type LoadedModelGuardrail,
} from "../guardrails/loaded.js";

/** A prompt as hashed: its rendered text (never the files' paths). */
const hashedText = (input: unknown): string => promptTextOf(input) ?? "";

const agentTexts = (prompts: Readonly<Record<string, unknown>>): Record<string, string> =>
  Object.fromEntries(Object.entries(prompts).map(([name, input]) => [name, hashedText(input)]));

/** Routers with their instructions and route conditions as rendered text. */
const routerTexts = (routers: readonly LoadedRouter[]) =>
  routers.map((router) => ({
    ...router,
    instructions: hashedText(router.instructions),
    routes: router.routes.map((route) => ({ ...route, condition: hashedText(route.condition) })),
  }));

/** The model arbiters' texts (#279): their prompt and each agent's criterion, by name. */
function arbiterTexts(graph: RuntimeGraph) {
  return arbiterClassesOf(graph.launches).flatMap((arbiter) => {
    const options = arbiterOf(arbiter)?.options;
    if (options === undefined || isCodeArbiter(options)) return [];
    const criteria = options.criteria.map(({ agent, prompt }) => ({
      agent: declarationOf(agent)?.options.name ?? agent.name,
      prompt: normalisePromptText(prompt),
    }));
    return [{ name: options.name, prompt: normalisePromptText(options.prompt), criteria }];
  });
}

/** What one workflow's snapshot is made of: its assembly (`AssembledWorkflow`) or its run deps. */
export type SnapshotSource<TName extends string = string> = Pick<
  AgentExecutionDeps<TName>,
  "config" | "prompts" | "graph" | "maxSteps" | "routers" | "compactions"
> & {
  readonly guardrails?: { readonly guardrails: readonly LoadedGuardrail[] } | undefined;
  readonly pii?: FingerprintDeps["pii"];
};

/**
 * The snapshot sources of the child workflows of an application by class (#336): its run deps'
 * `childDepsOf`, or its assembled workflows (`childSourcesIn`) where nothing runs (`describe`).
 */
export type ChildSnapshotSources = (workflow: Class) => SnapshotSource | undefined;

/** A workflow's snapshot, and how its children's are found (default: its deps' `childDepsOf`). */
export type SnapshotDeps<TName extends string> = SnapshotSource<TName> & {
  readonly childDepsOf?: ChildSnapshotSources | undefined;
};

/** The children of an application's assembled workflows, by class: every workflow it assembled. */
export function childSourcesIn(workflows: readonly SnapshotSource[]): ChildSnapshotSources {
  const byClass = new Map<Class, SnapshotSource>(
    workflows.map((workflow) => [workflow.graph.type, workflow]),
  );
  return (workflow) => byClass.get(workflow);
}

/**
 * Everything a run's behaviour depends on in one workflow's own config and prompts: the config, the
 * flow, the texts each model is sent (normalised, #120) and, per agent and model router, what its
 * model reads that its decorator does not say (`elements`, #120 PR 4), and the framework's own
 * texts (`frame`).
 */
const ownSnapshot = <TName extends string>(
  deps: SnapshotSource<TName>,
): Record<string, unknown> => ({
  config: stripFunctions(deps.config),
  flow: flowLines(deps.graph.flow, byComponentName),
  maxSteps: deps.maxSteps,
  routers: routerTexts(deps.routers),
  prompts: agentTexts(deps.prompts),
  elements: elementFingerprintsOf(deps),
  frame: framePrompts(deps.graph, deps.compactions, modelGuardrailsOf(deps.guardrails)),
  // the compactions (#120 PR 3): only a workflow that has one, so the others keep their hash
  ...compactionSnapshot(deps.compactions),
  // the guardrails (#120): only a workflow that has one, so the others keep their hash
  ...guardrailSnapshot(deps.guardrails?.guardrails ?? []),
});

/**
 * Every child workflow reachable from a workflow's flow (#336), depth first, each once, by name with
 * its own snapshot — never `ThisWorkflow` (a recursive workflow is hashed once, as the root), never
 * the workflow itself; a child `children` does not know is left out.
 */
function childSnapshotsOf(
  root: SnapshotSource,
  children: ChildSnapshotSources | undefined,
): readonly (readonly [string, unknown])[] {
  if (children === undefined) return [];
  const seen = new Set<Class>([root.graph.type]);
  const found: (readonly [string, unknown])[] = [];
  const visit = (source: SnapshotSource): void => {
    for (const workflow of childClassesOf(source.graph.flow)) {
      if (seen.has(workflow)) continue;
      seen.add(workflow);
      const child = children(workflow);
      if (child === undefined) continue;
      found.push([child.config.name, ownSnapshot(child)]);
      visit(child);
    }
  };
  visit(root);
  return [...found].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * What `configHash` hashes: the workflow's own snapshot and, for a workflow that launches child
 * workflows, `children` — every child reachable from its flow, recursively, each once by name
 * (#336: a child's change is a change of its root; a workflow without children keeps its hash).
 */
export const configSnapshot = <TName extends string>(
  deps: SnapshotDeps<TName>,
  children: ChildSnapshotSources | undefined = deps.childDepsOf,
): unknown => {
  const known = childSnapshotsOf(deps, children);
  return {
    ...ownSnapshot(deps),
    ...(known.length === 0 ? {} : { children: Object.fromEntries(known) }),
  };
};

/**
 * The framework's texts a workflow's models read (#120: part of the assembled prompt): the routers',
 * the agent loop's, the knowledge bases' framing; a launch router's, a compaction's, an arbiter's
 * and a guardrail's only where there is one.
 */
const framePrompts = (
  graph: RuntimeGraph,
  compactions: AssembledCompactions | undefined,
  guardrails: readonly LoadedModelGuardrail[],
): object => ({
  routers: routerPromptTexts,
  agentLoop: agentFramePromptTexts,
  rag: ragPromptTexts,
  // a router before a launch (#273 S23): only a workflow that has one
  ...(graph.launches.some((launch) => launch.launch.isRouterLaunch)
    ? { routerLaunch: routerLaunchPromptTexts }
    : {}),
  ...(summarisingOf(compactions).length === 0 ? {} : { compactionFrame: compactionPromptTexts }),
  ...(arbiterTexts(graph).length === 0 ? {} : { arbiterFrame: arbiterPromptTexts }),
  ...(guardrails.length === 0 ? {} : { guardrailFrame: guardrailPromptTexts }),
});

/** One guardrail as hashed: a model one's question, threshold and model; a code one's `decidedBy`. */
const guardrailEntryOf = (guardrail: LoadedGuardrail): object => {
  const { name, side, refusal } = guardrail;
  // a model guardrail keeps its shape before #383, so its workflow keeps its hash
  if (!isModelGuardrail(guardrail))
    return { name, side, decidedBy: guardrail.decidedBy, refusal: refusal ?? null };
  const { prompt, threshold, model } = guardrail;
  return { name, side, prompt, threshold, model, refusal: refusal ?? null };
};

/** What a workflow's guardrails decide with: their side, question, threshold, model and refusal. */
const guardrailSnapshot = (guardrails: readonly LoadedGuardrail[]): object =>
  guardrails.length === 0 ? {} : { guardrails: guardrails.map(guardrailEntryOf) };

/** The guardrails' questions (#120) in the prompt version; the key `guards` keeps the versions of workflows without them. */
const guardrailPrompts = (guardrails: readonly LoadedModelGuardrail[]): object => ({
  guards: guardrails.map(({ name, side, prompt, threshold }) => ({
    name,
    side,
    prompt,
    threshold,
  })),
});

/** The compactions that write summaries (their prompt is not `""`). */
const summarisingOf = (compactions: AssembledCompactions | undefined) =>
  (compactions?.compactions ?? []).filter((c) => c.prompt !== "");

/** The compactions' prompts (#120 PR 3) in the prompt version, only where one writes summaries. */
function compactionPrompts(compactions: AssembledCompactions | undefined): object {
  const summarising = summarisingOf(compactions);
  return summarising.length === 0
    ? {}
    : { compactions: summarising.map(({ name, prompt }) => ({ name, prompt })) };
}

/** The guardrails' models in the model version, only where there is one. */
const guardrailModels = (guardrails: readonly LoadedModelGuardrail[]): object =>
  guardrails.length === 0
    ? {}
    : { guardrails: guardrails.map(({ name, model }) => ({ name, model })) };

/** Prompt and model versions of the current configuration — stored with every Tern. */
export function executionVersions<TName extends string>(
  deps: AgentExecutionDeps<TName>,
): {
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly configVersion: string;
  readonly configHash: string;
} {
  const guardrails = modelGuardrailsOf(deps.guardrails);
  return {
    promptVersion: versionOf({
      agents: agentTexts(deps.prompts),
      flowRouters: routerTexts(deps.routers).map(({ name, instructions, routes }) => ({
        name,
        instructions,
        routes,
      })),
      ...framePrompts(deps.graph, deps.compactions, guardrails),
      ...compactionPrompts(deps.compactions),
      // model arbiters (#279): only a workflow that has one
      ...(arbiterTexts(deps.graph).length === 0 ? {} : { arbiters: arbiterTexts(deps.graph) }),
      ...guardrailPrompts(guardrails),
    }),
    modelVersion: versionOf({
      defaults: deps.config.defaults,
      routers: deps.routers.map(({ name, model }) => ({ name, model })),
      ...(modelArbitersOf(deps.graph.launches).length === 0
        ? {}
        : { arbiters: modelArbitersOf(deps.graph.launches) }),
      agents: deps.config.agents,
      ...guardrailModels(guardrails),
    }),
    configVersion: deps.config.version,
    configHash: versionOf(configSnapshot(deps)),
  };
}
