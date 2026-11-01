import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Class } from "../components/injection.js";
import type { Environment } from "../flow/generated-types.js";
import { declaredFieldsOf } from "./contract.js";
import { EnvironmentError, EnvironmentErrorCode } from "./errors.js";
import {
  describedEnvironment,
  resolveEnvironment,
  type DescribedEnvironment,
  type LoadedEnvironment,
} from "./resolve.js";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * Where an application's environments are and how one is chosen (#261): `environments/` next to the
 * application file, one `<name>.environment.ts` per environment exporting
 * `const environment: AppEnvironment = { … }`. Apps default to `dev`, tests to `test` — a test
 * never falls back to another environment.
 */

/** The environment an app runs with when none is named (`createApp`, the CLI). */
export const APP_DEFAULT_ENVIRONMENT = "dev";
/** The environment a test runs with when none is named: its own, never dev's addresses. */
export const TEST_DEFAULT_ENVIRONMENT = "test";

/** What an application says about its environments: its name, file and contract. */
export interface EnvironmentOwner {
  /** The application's `name`, for messages. */
  readonly application: string;
  /** The file `@Application` is declared in: `environments/` is next to it. */
  readonly source?: string | undefined;
  /** `@Application({ environment })`; absent = a workflow no application lists (or an untyped caller). */
  readonly contract?: Class | undefined;
}

/** Which environment to run with: a name, else the default. */
export interface EnvironmentSelection {
  /** The name of `environments/<env>.environment.ts` next to the application file. */
  readonly env?: string | undefined;
}

const FILE = /^(.+)\.environment\.(ts|mts|js|mjs)$/;
const EXTENSIONS = ["ts", "mts", "js", "mjs"] as const;

const environmentsDirOf = (source: string): string => join(dirname(source), "environments");

const fileOf = (dir: string, name: string): string | undefined =>
  EXTENSIONS.map((ext) => join(dir, `${name}.environment.${ext}`)).find((file) => existsSync(file));

type EnvironmentModule = Readonly<Record<string, unknown>>;

const importModule = async (file: string): Promise<EnvironmentModule> =>
  (await lazyLoad(import(pathToFileURL(file).href))) as EnvironmentModule;

/** The environments of a folder (`dev`, `staging`, …): files that export `environment`, sorted. */
async function availableEnvironments(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const names = [...new Set(readdirSync(dir).flatMap((file) => FILE.exec(file)?.[1] ?? []))].filter(
    (name) => !name.endsWith(".d"),
  );
  const found: string[] = [];
  for (const name of names.sort()) {
    const file = fileOf(dir, name);
    if (file !== undefined && "environment" in (await importModule(file))) found.push(name);
  }
  return found;
}

/** What to say when `<name>.environment.ts` is missing: the test environment names the fix. */
async function notFound(owner: EnvironmentOwner, dir: string, name: string): Promise<never> {
  const path = join(dir, `${name}.environment.ts`);
  const contract = owner.contract?.name ?? "Environment";
  if (name === TEST_DEFAULT_ENVIRONMENT) {
    throw new EnvironmentError(
      EnvironmentErrorCode.NotFound,
      `Environment "test" not found: ${path} — tests run on the test environment, never on dev's values: create it (export const environment: ${contract} = { … })`,
    );
  }
  const available = await availableEnvironments(dir);
  throw new EnvironmentError(
    EnvironmentErrorCode.NotFound,
    `Environment "${name}" not found: ${path}. Available: ${available.length === 0 ? "none" : available.join(", ")}`,
  );
}

/** The `environment` export of `<dir>/<name>.environment.ts`. */
async function loadValues(owner: EnvironmentOwner, dir: string, name: string): Promise<unknown> {
  const file = fileOf(dir, name);
  if (file === undefined) return notFound(owner, dir, name);
  const module = await importModule(file);
  if ("environment" in module) return module.environment;
  const contract = owner.contract?.name ?? "Environment";
  const isContract = owner.contract !== undefined && Object.values(module).includes(owner.contract);
  throw new EnvironmentError(
    EnvironmentErrorCode.NotFound,
    isContract
      ? `${file} holds the contract ${contract}, not an environment — name another environment`
      : `${file} must export the environment: export const environment: ${contract} = { … }`,
  );
}

/** The environment file to load; none when the application declares no environment and none is named. */
export async function selectedEnvironment(
  owner: EnvironmentOwner,
  env: string | undefined,
  defaultName: string = APP_DEFAULT_ENVIRONMENT,
): Promise<LoadedEnvironment | undefined> {
  const { contract } = owner;
  if (contract === undefined) {
    if (env === undefined) return undefined;
    throw new EnvironmentError(
      EnvironmentErrorCode.NoContract,
      `Environment "${env}": ${owner.application} declares no environment — add @Application({ environment: AppEnvironment }) and environments/${env}.environment.ts next to the application file`,
    );
  }
  const name = env ?? defaultName;
  // a contract with no fields (an application with no settings) needs no file for its default
  if (env === undefined && declaredFieldsOf(contract).length === 0) {
    const file =
      owner.source === undefined ? undefined : fileOf(environmentsDirOf(owner.source), name);
    if (file === undefined) return { name, contract: contract.name, values: {} };
  }
  if (owner.source === undefined) {
    throw new EnvironmentError(
      EnvironmentErrorCode.NotFound,
      `Environment "${name}" not found: the file of ${owner.application} is unknown`,
    );
  }
  const values = await loadValues(owner, environmentsDirOf(owner.source), name);
  return { name, contract: contract.name, values };
}

/** The application's environment, resolved against `processEnv`; none when it declares none. */
export async function environmentFor(
  owner: EnvironmentOwner,
  selection: EnvironmentSelection,
  processEnv: NodeJS.ProcessEnv,
  defaultName: string = APP_DEFAULT_ENVIRONMENT,
): Promise<Environment | undefined> {
  const loaded = await selectedEnvironment(owner, selection.env, defaultName);
  return loaded === undefined ? undefined : resolveEnvironment(loaded, processEnv);
}

/** The chosen environment's name and values (`applicationContext.environmentName` / `.environment`). */
export interface NamedEnvironment {
  readonly environmentName?: string;
  readonly environment?: Environment;
}

/** Like `environmentFor`, with the chosen environment's name: what an application instance runs on. */
export async function namedEnvironmentFor(
  owner: EnvironmentOwner,
  selection: EnvironmentSelection,
  processEnv: NodeJS.ProcessEnv,
  defaultName: string = APP_DEFAULT_ENVIRONMENT,
): Promise<NamedEnvironment> {
  const loaded = await selectedEnvironment(owner, selection.env, defaultName);
  if (loaded === undefined) return {};
  return { environmentName: loaded.name, environment: resolveEnvironment(loaded, processEnv) };
}

/** The environment for `agboss describe`: like `environmentFor`, but a missing variable is shown, not fatal. */
export async function describedEnvironmentFor(
  owner: EnvironmentOwner,
  env: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): Promise<DescribedEnvironment | undefined> {
  const loaded = await selectedEnvironment(owner, env);
  return loaded === undefined ? undefined : describedEnvironment(loaded, processEnv);
}
