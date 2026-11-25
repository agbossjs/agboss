import { pathToFileURL } from "node:url";
import { lazyLoad } from "../../infrastructure/clock.js";
import { builtApplicationOf } from "../../application/create-app.js";
import { adoptTemporaryFile } from "../../storage/drivers.js";
import { FORK_ENV, forkSpecOf } from "./isolated-fork.js";

/**
 * The process of an isolated worker (#1286b): started by `isolated-fork.ts`, it loads the entry
 * module, builds the application as a fork — its one worker claims the child it was started for by
 * its id and runs it; no sweep, no general claim — and closes the application, then exits, once that
 * child ended or paused. A closed channel to the supervisor closes it too. The child is claimed
 * under this process's own `instanceId`: when the process dies, its lease expires and a live worker
 * takes the child over.
 */

const spec = forkSpecOf(process.env);
if (spec === undefined)
  throw new Error(`${FORK_ENV} is not set: this module is started by a supervisor`);
Reflect.deleteProperty(process.env, FORK_ENV);
if (spec.databasePath !== undefined) adoptTemporaryFile(spec.databasePath);

const entry = spec.entry.startsWith("file:") ? spec.entry : pathToFileURL(spec.entry).href;
const loaded = (await lazyLoad(import(entry))) as { readonly default?: unknown };
if (typeof loaded.default !== "function")
  throw new Error(`${spec.entry} has no default export: it must export the @Application class`);

let resolveEnded = (): void => undefined;
const ended = new Promise<void>((resolve) => {
  resolveEnded = resolve;
});
process.once("disconnect", resolveEnded);
const built = await builtApplicationOf(
  loaded.default as new () => unknown,
  {
    ...(spec.environmentName === undefined ? {} : { env: spec.environmentName }),
    ...(spec.profile === undefined ? {} : { profile: spec.profile }),
  },
  {
    isolatedChild: {
      tenantId: spec.tenantId,
      executionId: spec.executionId,
      onEnded: resolveEnded,
    },
  },
);
await ended;
await built.app.close();
process.exit(0);
