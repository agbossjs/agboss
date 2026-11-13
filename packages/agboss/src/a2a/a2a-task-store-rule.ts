import type { ApplicationOptions } from "../application/application.js";
import {
  backendOf,
  hasTwoListed,
  implementationsOf,
  ImplementationReason,
  leaseStoreOf,
} from "../application/implementations.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { A2ATaskRepository } from "../infrastructure/a2a-task.repository.js";
import { definedOf } from "../infrastructure/clock.js";
import { A2ADirectMessageRepository } from "../infrastructure/a2a-direct-message.repository.js";
import { messageSkillsOf } from "./a2a-message-skill-rule.js";

/**
 * Fail closed at assembly (#824): an application that serves A2A (`@A2AExpose`) dedupes a message
 * and finds a task in its `A2ATaskRepository`, so on leases its instances share (any backend but
 * `in-memory`) its tasks must be shared by them too: on its lease store's own backend, or on a
 * backend kind known to be shared by instances on any host (`postgres`, `mongodb`). Anything else —
 * the in-memory default, an undeclared backend, SQLite beside other leases, a backend no rule knows
 * (an allow-list: an unknown name, or a known one in other letters, is never taken as shared) — is
 * `[a2a.task-store-not-shared]`: a message resent to another instance would start a second
 * execution. Read from the declarations only, as the store-backend rules are.
 */

/** The backend kinds whose rows the instances of any host share. */
const SHARED: ReadonlySet<string> = new Set(["postgres", "mongodb"]);

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
  return tasks === leases || SHARED.has(kindOf(tasks));
}

/** The names of the application's `@A2AExpose`s. */
const a2aExposesOf = (options: ApplicationOptions): readonly string[] =>
  // Stryker disable next-line ArrayDeclaration: an entry that is no class is no @A2AExpose: none either way
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

/** Whose rows a backend kind keeps that is not shared here. */
function whoseOf(kind: string): string {
  if (kind === "in-memory") return "each instance's own";
  return kind === "sqlite" ? "one host's" : "not known to be shared";
}

function tasksText(tasks: Class, backend: string | undefined, reason: ImplementationReason) {
  const listed =
    reason === ImplementationReason.Default ? ", the built-in default: none listed" : "";
  if (backend === undefined)
    return `${tasks.name}, which declares no backend${listed}: each instance's own, for all assembly knows`;
  return `${tasks.name} (backend "${backend}"${listed}), ${whoseOf(kindOf(backend))}`;
}

/** What to list in place of the task store. */
function fixOf(leases: string | undefined): string {
  if (leases === undefined)
    return `declare the lease store's backend (static store = { backend: "postgres" }) and list an A2A task store on it`;
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
  // Stryker disable next-line ArrayDeclaration: an entry that is no class is no store: the defaults either way
  const providers = options.providers ?? [];
  const leases = leaseStoreOf(providers);
  // no A2A served, or two lease or two task stores (their ambiguity is reported first, #960)
  if (exposes.length === 0 || leases === undefined || hasTwoListed(providers, A2ATaskRepository))
    return [];
  const choice = definedOf(
    implementationsOf(providers).find(({ contract }) => contract === A2ATaskRepository),
    // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
    "A2ATaskRepository is a built-in contract",
  );
  const [leaseBackend, taskBackend] = [backendOf(leases), backendOf(choice.implementation)];
  if (isShared(leaseBackend, taskBackend)) return [];
  const message = `${options.name} serves A2A (${exposes.join(", ")}) on ${leasesText(leases, leaseBackend)}, but keeps its A2A tasks in ${tasksText(choice.implementation, taskBackend, choice.reason)}: a message resent to another instance would start a second execution — ${fixOf(leaseBackend)}`;
  return [violation("a2a.task-store-not-shared", message, [options.name])];
}

/**
 * Fail closed at assembly (#860): an application that exposes a direct-reply skill
 * (`A2AReply.Message`) keeps the replies in its `A2ADirectMessageRepository`, which claims each
 * message's id among its A2A task store's messages in one atomic write — so the two must declare
 * one backend, the same text (`static store = { backend }`): its task store's, which
 * `[a2a.task-store-not-shared]` already makes the one its instances share. Anything else — an
 * undeclared backend, the in-memory default beside a SQLite or PostgreSQL task store, another
 * database — is `[a2a.message-store-not-shared]`: a message resent to another instance, or a
 * task message of the same id, would run the skill again. Read from the declarations only.
 */

/** The direct message store of each backend kind, as the fix names it. */
const DIRECT_STORE_OF_KIND: Readonly<Record<string, string>> = {
  postgres: "PostgresA2ADirectMessageRepository (@agboss/postgres)",
  mongodb: "MongoA2ADirectMessageRepository (@agboss/mongodb)",
  sqlite: "SqliteA2ADirectMessageRepository",
  "in-memory": "InMemoryA2ADirectMessageRepository (the default: list none)",
};

/** The names of the application's exposes with a direct-reply skill. */
const directExposesOf = (options: ApplicationOptions): readonly string[] =>
  // Stryker disable next-line ArrayDeclaration: no exposes, no skills either way
  (options.exposes ?? []).flatMap((expose) => {
    const meta = componentOf(expose);
    return meta?.kind === "a2a-expose" && messageSkillsOf(meta.meta).length > 0
      ? [meta.meta.name]
      : [];
  });

/** The class the application uses for `contract`: listed, else the built-in default. */
const implementationOf = (options: ApplicationOptions, contract: Class): Class =>
  definedOf(
    // Stryker disable next-line ArrayDeclaration: an entry that is no class is no store: the defaults either way
    implementationsOf(options.providers ?? []).find((choice) => choice.contract === contract),
    // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
    "the A2A stores are built-in contracts",
  ).implementation;

const shownStore = (store: Class, backend: string | undefined): string =>
  backend === undefined
    ? `${store.name}, which declares no backend`
    : `${store.name} (backend "${backend}")`;

/** What to list in place of the direct message store. */
function directFixOf(tasks: string | undefined): string {
  if (tasks === undefined)
    return "declare the A2A task store's backend and list a direct message store on it";
  const store = Object.hasOwn(DIRECT_STORE_OF_KIND, kindOf(tasks))
    ? DIRECT_STORE_OF_KIND[kindOf(tasks)]
    : undefined;
  return store === undefined
    ? `list an A2A direct message store declaring backend "${tasks}" in @Application({ providers })`
    : `list ${store} in @Application({ providers })`;
}

/** `[a2a.message-store-not-shared]` of an application, or none. */
export function a2aMessageStoreViolations(options: ApplicationOptions): RuleViolation[] {
  const exposes = directExposesOf(options);
  if (exposes.length === 0) return [];
  const tasks = implementationOf(options, A2ATaskRepository);
  const messages = implementationOf(options, A2ADirectMessageRepository);
  const [taskBackend, messageBackend] = [backendOf(tasks), backendOf(messages)];
  if (taskBackend !== undefined && taskBackend === messageBackend) return [];
  const message = `${options.name} answers direct A2A messages (${exposes.join(", ")}) from ${shownStore(messages, messageBackend)}, but keeps its A2A tasks in ${shownStore(tasks, taskBackend)}: a message's id is claimed among its tasks' messages, so a resend or a task message of the same id would run the skill again — ${directFixOf(taskBackend)}`;
  return [violation("a2a.message-store-not-shared", message, [options.name])];
}
