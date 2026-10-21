import { compactionPromptTexts } from "../prompts/compaction.js";
import type { AssembledCompactions } from "../compaction/assembly.js";
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
import {
  agentFramePromptTexts,
  elementFingerprintsOf,
  type FingerprintDeps,
} from "./fingerprints.js";
import { normalisePromptText, promptTextOf } from "../components/prompt-render.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";
import type { LoadedGuardrail } from "../guardrails/assembly.js";

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

/**
 * Everything a run's behaviour depends on in config and prompts — what `configHash` hashes: the
 * config, the flow, the texts each model is sent (normalised, #120) and, per agent and model router,
 * what its model reads that its decorator does not say (`elements`, #120 PR 4), and the framework's
 * own texts (`frame`).
 */
export const configSnapshot = <TName extends string>(
  deps: Pick<
    AgentExecutionDeps<TName>,
    "config" | "prompts" | "graph" | "maxSteps" | "routers" | "compactions"
  > & {
    readonly guardrails?: { readonly guardrails: readonly LoadedGuardrail[] } | undefined;
    readonly pii?: FingerprintDeps["pii"];
  },
): unknown => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  config: stripFunctions(deps.config),
  flow: flowLines(deps.graph.flow, byComponentName),
  maxSteps: deps.maxSteps,
  routers: routerTexts(deps.routers),
  prompts: agentTexts(deps.prompts),
  elements: elementFingerprintsOf(deps),
  frame: framePrompts(deps.graph, deps.compactions, deps.guardrails?.guardrails ?? []),
  // the compactions (#120 PR 3): only a workflow that has one, so the others keep their hash
  ...compactionSnapshot(deps.compactions),
  // the guardrails (#120): only a workflow that has one, so the others keep their hash
  ...guardrailSnapshot(deps.guardrails?.guardrails ?? []),
});

/**
 * The framework's texts a workflow's models read (#120: part of the assembled prompt): the routers',
 * the agent loop's, the knowledge bases' framing; a launch router's, a compaction's, an arbiter's
 * and a guardrail's only where there is one.
 */
const framePrompts = (
  graph: RuntimeGraph,
  compactions: AssembledCompactions | undefined,
  guardrails: readonly LoadedGuardrail[],
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

/** What a workflow's compactions summarise with: their strategy and prompt, by name. */
const compactionSnapshot = (compactions: AssembledCompactions | undefined): object =>
  compactions === undefined || compactions.compactions.length === 0
    ? {}
    : {
        compactions: compactions.compactions.map(({ name, strategy, prompt }) => ({
          name,
          strategy,
          prompt,
        })),
      };

/** What a workflow's guardrails decide with: their side, question, threshold, model and refusal. */
const guardrailSnapshot = (guardrails: readonly LoadedGuardrail[]): object =>
  guardrails.length === 0
    ? {}
    : {
        guardrails: guardrails.map(({ name, side, prompt, threshold, model, refusal }) => ({
          name,
          side,
          prompt,
          threshold,
          model,
          refusal: refusal ?? null,
        })),
      };

/** The guardrails' questions (#120) in the prompt version; the key `guards` keeps the versions of workflows without them. */
const guardrailPrompts = (guardrails: readonly LoadedGuardrail[]): object => ({
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
const guardrailModels = (guardrails: readonly LoadedGuardrail[]): object =>
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
  const guardrails = deps.guardrails?.guardrails ?? [];
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
