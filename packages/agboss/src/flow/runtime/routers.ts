import type { PromptLoader } from "../../components/prompt-render.js";
import { NodeKind } from "../ast.js";
import { declarationOf, type Declared } from "../decorators/declaration.js";
import { isCodeRouter, type ModelRouterOptions } from "../decorators/router.js";
import type { RuntimeGraph } from "./graph-model.js";

/**
 * The model routers of a workflow with their texts loaded (#272): how to choose (`prompt` /
 * `promptUrls`) and what each route means (its prompt) — static, so the vendors' caches hold them;
 * the router's `input` reaches its model in the input message. A code router (#280) has no texts.
 * After `.chooseOne(…)` every route is a choice; hiding a launch's `Always` routes is #273's.
 */

export type ModelRouterDeclaration = Declared<NodeKind.Router, ModelRouterOptions>;

/** One route as the router's model sees it: the target's node id and what choosing it means. */
export interface LoadedRoute {
  readonly option: string;
  readonly condition: string;
}

/** A router with its texts loaded; routes sorted by option (their order carries no meaning). */
export interface LoadedRouter {
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly maxVisits?: number;
  readonly instructions: string;
  readonly routes: readonly LoadedRoute[];
}

const byOption = (left: LoadedRoute, right: LoadedRoute): number =>
  left.option < right.option ? -1 : left.option > right.option ? 1 : 0;

/** One model router with its texts loaded, named `name` (its node id). */
export async function loadRouter(
  name: string,
  declaration: ModelRouterDeclaration,
  loader: PromptLoader,
  defaultModel: string | undefined,
): Promise<LoadedRouter> {
  const { options, source } = declaration;
  const label = `@Router "${options.name}"`;
  const variables = options.promptVariables ?? {};
  const routes = await Promise.all(
    options.routes.map(async (route) => {
      const option = declarationOf(route.target)?.options.name ?? route.target.name;
      const owner = { label: `${label} route "${option}"`, source, variables };
      return { option, condition: await loader.load({ ...owner, options: route }) };
    }),
  );
  return {
    name,
    description: options.description,
    model: options.model ?? defaultModel ?? "",
    ...(options.maxVisits === undefined ? {} : { maxVisits: options.maxVisits }),
    instructions: await loader.load({ label, options, source, variables }),
    routes: [...routes].sort(byOption),
  };
}

/** Every model router of the graph, texts read and checked (problems kept in `loader`). */
export async function loadRouters(
  graph: RuntimeGraph,
  loader: PromptLoader,
  defaultModel: string | undefined,
): Promise<readonly LoadedRouter[]> {
  const routers = [...graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Router) return [];
    const { options } = declaration;
    return isCodeRouter(options) ? [] : [{ node, declaration: { ...declaration, options } }];
  });
  return Promise.all(
    routers.map(({ node, declaration }) => loadRouter(node.id, declaration, loader, defaultModel)),
  );
}
