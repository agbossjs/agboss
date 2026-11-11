import type { ApplicationOptions } from "../application/application.js";
import { backendOf, implementationsOf } from "../application/implementations.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { A2ADirectMessageRepository } from "../infrastructure/a2a-direct-message.repository.js";
import { A2ATaskRepository } from "../infrastructure/a2a-task.repository.js";
import { definedOf } from "../infrastructure/clock.js";
import { messageSkillsOf } from "./a2a-message-skill-rule.js";

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
const STORE_OF_KIND: Readonly<Record<string, string>> = {
  postgres: "PostgresA2ADirectMessageRepository (@agboss/postgres)",
  mongodb: "MongoA2ADirectMessageRepository (@agboss/mongodb)",
  sqlite: "SqliteA2ADirectMessageRepository",
  "in-memory": "InMemoryA2ADirectMessageRepository (the default: list none)",
};

/** `"postgres"` of `"postgres:billing"`. */
const kindOf = (backend: string): string => backend.split(":", 1)[0] ?? backend;

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

const shown = (store: Class, backend: string | undefined): string =>
  backend === undefined ? `${store.name}, which declares no backend` : `${store.name} (backend "${backend}")`;

/** What to list in place of the direct message store. */
function fixOf(tasks: string | undefined): string {
  if (tasks === undefined)
    return "declare the A2A task store's backend and list a direct message store on it";
  const store = Object.hasOwn(STORE_OF_KIND, kindOf(tasks)) ? STORE_OF_KIND[kindOf(tasks)] : undefined;
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
  const message = `${options.name} answers direct A2A messages (${exposes.join(", ")}) from ${shown(messages, messageBackend)}, but keeps its A2A tasks in ${shown(tasks, taskBackend)}: a message's id is claimed among its tasks' messages, so a resend or a task message of the same id would run the skill again — ${fixOf(taskBackend)}`;
  return [violation("a2a.message-store-not-shared", message, [options.name])];
}
