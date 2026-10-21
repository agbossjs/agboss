import { agentLoopPromptTexts } from "../prompts/agents.js";
import { DEFAULT_COMPACTION_PROMPT } from "../prompts/compaction.js";
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
import type { RunDeps } from "./types.js";

import { stripFunctions } from "./strip-functions.js";
import { promptTextOf } from "../components/prompt-render.js";
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
      prompt,
    }));
    return [{ name: options.name, prompt: options.prompt, criteria }];
  });
}

/** Everything a run's behaviour depends on in config and prompts — what `configHash` hashes. */

export const configSnapshot = <TName extends string>(
  deps: Pick<
    RunDeps<TName>,
    "config" | "prompts" | "compactionPrompt" | "graph" | "maxSteps" | "routers"
  > & {
    readonly guardrails?: { readonly guardrails: readonly LoadedGuardrail[] } | undefined;
  },
): unknown => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  config: stripFunctions(deps.config),
  flow: flowLines(deps.graph.flow, byComponentName),
  maxSteps: deps.maxSteps,
  routers: routerTexts(deps.routers),
  prompts: agentTexts(deps.prompts),
  compactionPrompt: deps.compactionPrompt ?? null,
  // the guardrails (#120): only a workflow that has one, so the others keep their hash
  ...guardrailSnapshot(deps.guardrails?.guardrails ?? []),
});

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

/**
 * The guardrails' questions (#120) in the prompt version; the key `guards` keeps the versions of
 * workflows without them, the frame's texts only where there is one.
 */
const guardrailPrompts = (guardrails: readonly LoadedGuardrail[]): object => ({
  guards: guardrails.map(({ name, side, prompt, threshold }) => ({
    name,
    side,
    prompt,
    threshold,
  })),
  ...(guardrails.length === 0 ? {} : { guardrailFrame: guardrailPromptTexts }),
});

/** The guardrails' models in the model version, only where there is one. */
const guardrailModels = (guardrails: readonly LoadedGuardrail[]): object =>
  guardrails.length === 0
    ? {}
    : { guardrails: guardrails.map(({ name, model }) => ({ name, model })) };

/** Prompt and model versions of the current configuration — stored with every Tern. */
export function runVersions<TName extends string>(
  deps: RunDeps<TName>,
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
      routers: routerPromptTexts,
      flowRouters: routerTexts(deps.routers).map(({ name, instructions, routes }) => ({
        name,
        instructions,
        routes,
      })),
      agentLoop: agentLoopPromptTexts,
      rag: ragPromptTexts,
      // a router before a launch (#273 S23): only a workflow that has one
      ...(deps.graph.launches.some((launch) => launch.launch.isRouterLaunch)
        ? { routerLaunch: routerLaunchPromptTexts }
        : {}),
      ...(deps.config.compaction === undefined
        ? {}
        : { compaction: deps.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT }),
      // model arbiters (#279): only a workflow that has one
      ...(arbiterTexts(deps.graph).length === 0
        ? {}
        : { arbiters: arbiterTexts(deps.graph), arbiterFrame: arbiterPromptTexts }),
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
