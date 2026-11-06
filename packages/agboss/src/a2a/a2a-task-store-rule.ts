import type { ApplicationOptions } from "../application/application.js";
import {
  backendOf,
  implementationsOf,
  ImplementationReason,
  leaseStoreOf,
} from "../application/implementations.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { A2ATaskRepository } from "../infrastructure/a2a-task.repository.js";

/**
 * Fail closed at assembly (#824): an application that serves A2A (`@A2AExpose`) dedupes a message
 * and finds a task in its `A2ATaskRepository`, so on leases its instances share (any backend but
 * `in-memory`) its tasks must be shared by them too — on its lease store's backend, or on another
 * backend no single host owns (`in-memory` and `sqlite` are one host's). Anything else — the
 * in-memory default, an undeclared backend, a single-host one other than the leases' — is
 * `[a2a.task-store-not-shared]`: a message resent to another instance would start a second
 * execution. Read from the declarations only, as the store-backend rules are.
 */

/** The backends whose rows only one host's instances share. */
const SINGLE_HOST: ReadonlySet<string> = new Set(["in-memory", "sqlite"]);

/** The A2A task store of each backend kind, as the fix names it. */
const STORE_OF_KIND: Readonly<Record<string, string>> = {
  postgres: "PostgresA2ATaskRepository (@agboss/postgres)",
  mongodb: "MongoA2ATaskRepository (@agboss/mongodb)",
  sqlite: "SqliteA2ATaskRepository",
};

/** `"postgres"` of `"postgres:billing"`. */
const kindOf = (backend: string): string => backend.split(":", 1)[0] ?? backend;

/** Whether tasks on `tasks` are shared by the instances that share leases on `leases`. */
function isShared(leases: string | undefined, tasks: string | undefined): boolean {
  if (leases === "in-memory") return true;
  if (tasks === undefined) return false;
  return tasks === leases || !SINGLE_HOST.has(kindOf(tasks));
}

/** The names of the application's `@A2AExpose`s. */
const a2aExposesOf = (options: ApplicationOptions): readonly string[] =>
  (options.exposes ?? []).flatMap((expose) => {
    const meta = componentOf(expose);
    return meta?.kind === "a2a-expose" ? [meta.meta.name] : [];
  });

/** `PostgresLeases (backend "postgres"), which its instances share` and the like. */
function leasesText(leases: Class, backend: string | undefined): string {
  return backend === undefined
    ? `${leases.name}, which declares no backend`
    : `${leases.name} (backend "${backend}"), which its instances share`;
}

function tasksText(tasks: Class, backend: string | undefined, reason: ImplementationReason) {
  const listed =
    reason === ImplementationReason.Default ? ", the built-in default: none listed" : "";
  if (backend === undefined)
    return `${tasks.name}, which declares no backend${listed}: each instance's own, for all assembly knows`;
  return `${tasks.name} (backend "${backend}"${listed}), ${
    kindOf(backend) === "in-memory" ? "each instance's own" : "one host's"
  }`;
}

/** What to list in place of the task store. */
function fixOf(leases: string | undefined): string {
  if (leases === undefined)
    return `declare the lease store's backend (static backend = "postgres") and list an A2A task store on it`;
  const kind = kindOf(leases);
  if (kind === "redis")
    return "list an A2A task store on a durable backend (PostgresA2ATaskRepository, MongoA2ATaskRepository) in @Application({ providers }): Redis keeps no A2A tasks";
  const store = Object.hasOwn(STORE_OF_KIND, kind) ? STORE_OF_KIND[kind] : undefined;
  return store === undefined
    ? `list an A2A task store declaring backend "${leases}" in @Application({ providers })`
    : `list ${store} in @Application({ providers })`;
}

/** `[a2a.task-store-not-shared]` of an application, or none. */
export function a2aTaskStoreViolations(options: ApplicationOptions): RuleViolation[] {
  const exposes = a2aExposesOf(options);
  const providers = options.providers ?? [];
  const leases = leaseStoreOf(providers);
  // no A2A served, or two lease stores (their ambiguity is reported first)
  if (exposes.length === 0 || leases === undefined) return [];
  const choice = implementationsOf(providers).find(
    ({ contract }) => contract === A2ATaskRepository,
  );
  // Stryker disable next-line ConditionalExpression: A2ATaskRepository is always a built-in contract
  if (choice === undefined) return [];
  const [leaseBackend, taskBackend] = [backendOf(leases), backendOf(choice.implementation)];
  if (isShared(leaseBackend, taskBackend)) return [];
  const message = `${options.name} serves A2A (${exposes.join(", ")}) on ${leasesText(leases, leaseBackend)}, but keeps its A2A tasks in ${tasksText(choice.implementation, taskBackend, choice.reason)}: a message resent to another instance would start a second execution — ${fixOf(leaseBackend)}`;
  return [violation("a2a.task-store-not-shared", message, [options.name])];
}
