import { agentLoopPromptTexts } from "../prompts/agents.js";
import { DEFAULT_COMPACTION_PROMPT } from "../prompts/compaction.js";
import { ragPromptTexts } from "../prompts/rag.js";
import { routerLaunchPromptTexts } from "../prompts/router-launch.js";
import { routerPromptTexts } from "../routers/index.js";
import { versionOf } from "../terns/index.js";
import { byComponentName, flowLines } from "../flow/print.js";
import type { RunDeps } from "./types.js";

import { stripFunctions } from "./strip-functions.js";
import { promptTextOf } from "../components/prompt-render.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";

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

/** Everything a run's behaviour depends on in config and prompts — what `configHash` hashes. */

export const configSnapshot = <TName extends string>(
  deps: Pick<
    RunDeps<TName>,
    "config" | "prompts" | "compactionPrompt" | "graph" | "maxSteps" | "routers"
  >,
): unknown => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  config: stripFunctions(deps.config),
  flow: flowLines(deps.graph.flow, byComponentName),
  maxSteps: deps.maxSteps,
  routers: routerTexts(deps.routers),
  prompts: agentTexts(deps.prompts),
  compactionPrompt: deps.compactionPrompt ?? null,
});

/** Prompt and model versions of the current configuration — stored with every Tern. */
export function runVersions<TName extends string>(
  deps: RunDeps<TName>,
): {
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly configVersion: string;
  readonly configHash: string;
} {
  const guards = [...deps.guards.input, ...deps.guards.output].map(
    ({ name, question, flag, pass }) => ({
      name,
      question,
      flag,
      pass,
    }),
  );
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
      guards,
    }),
    modelVersion: versionOf({
      defaults: deps.config.defaults,
      routers: deps.routers.map(({ name, model }) => ({ name, model })),
      agents: deps.config.agents,
    }),
    configVersion: deps.config.version,
    configHash: versionOf(configSnapshot(deps)),
  };
}
