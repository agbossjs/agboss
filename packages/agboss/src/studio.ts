import { createAppDeps, type AppDeps, type AppDepsOptions } from "./app/app-deps.js";
import { applicationOf } from "./application/assemble.js";
import { environmentOwnerOf } from "./application/create-app.js";
import type { Class } from "./components/index.js";
import { namedEnvironmentFor } from "./environments/load.js";
import type { ExecutionGraph } from "./flow/runtime/build.js";
import { studioGraph } from "./graph/studio-graph.js";

/**
 * The graphs `agboss studio` serves (#268 AC7): every workflow of an `@Application` — the listed ones
 * and the children they launch — built on the application's environment. A child is a subgraph node
 * of its parent (#263 S37), so Studio draws it inside; `ThisWorkflow` is a node marked
 * `recursive: maxDepth N` (#264). The module `agboss studio` writes into `.agboss/` reads them by name.
 */

/** How `agboss studio` builds the graphs: the environment (`--env`, default `dev`). */
export interface StudioOptions extends Pick<AppDepsOptions, "gateway"> {
  /** `environments/<env>.environment.ts` next to the application file; default `dev`. */
  readonly env?: string | undefined;
  /** The process environment the environment reads; default `process.env`. */
  readonly processEnv?: NodeJS.ProcessEnv;
}

/** Every workflow of the application, by its `name`, as Studio draws and runs it. */
export interface StudioGraphs {
  /** The application's `name`. */
  readonly application: string;
  /** The workflows' names in the application's order, a child after the workflow launching it. */
  readonly names: readonly string[];
  /** The graph of the workflow of that name; an unknown name throws, naming the known ones. */
  readonly graph: (name: string) => ExecutionGraph;
  /** Closes what the workflows opened (their stores, MCP servers). */
  readonly close: () => Promise<void>;
}

/** A test's scripted gateway; Studio itself calls the application's model providers. */
const gatewayOf = ({ gateway }: StudioOptions): Pick<AppDepsOptions, "gateway"> =>
  gateway === undefined ? {} : { gateway };

/**
 * The application assembled as `createApp` assembles it, every workflow's graph built on its
 * environment: `const studio = await studioOf(JobScoutApplication, { env: "dev" })`, then
 * `studio.graph("job-scout-workflow")`.
 */
export async function studioOf(
  application: Class,
  options: StudioOptions = {},
): Promise<StudioGraphs> {
  const processEnv = options.processEnv ?? process.env;
  const assembled = await applicationOf(application, {}, "agboss studio");
  const environment = await namedEnvironmentFor(
    environmentOwnerOf(assembled),
    { env: options.env },
    processEnv,
  );
  const built: AppDeps[] = [];
  for (const workflow of assembled.workflows)
    built.push(
      await createAppDeps(workflow, { ...environment, processEnv, ...gatewayOf(options) }),
    );
  const graphs = new Map(built.map((deps) => [deps.config.name, studioGraph(deps)] as const));
  const names = [...graphs.keys()];
  return {
    application: assembled.name,
    names,
    graph: (name: string): ExecutionGraph => {
      const found = graphs.get(name);
      if (found === undefined)
        throw new TypeError(
          `${assembled.name} has no workflow "${name}"; its workflows: ${names.join(", ")}`,
        );
      return found;
    },
    close: async (): Promise<void> => {
      for (const deps of built) await deps.close();
    },
  };
}
