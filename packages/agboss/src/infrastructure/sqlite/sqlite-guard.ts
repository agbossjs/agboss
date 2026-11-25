import type { DatabaseSync } from "node:sqlite";
import type { CleanAttempt } from "./sqlite-attempt.js";
import type { SqliteMutex } from "./sqlite-mutex.js";
import type { ServedGroups } from "./sqlite-served.js";

/** What a statement of the connection asks before it runs. */
export interface StatementGuards {
  readonly mutex: SqliteMutex;
  readonly owner: object;
  readonly attempt: CleanAttempt;
  readonly served: ServedGroups;
}

/** The checks before a statement: served (never after an operation's await), the mutex, then the attempt's lock. */
function beforeStatement(guards: StatementGuards, sql: unknown): void {
  guards.served.assertServed();
  guards.mutex.assertMayRun(guards.owner);
  if (typeof sql === "string") guards.attempt.beforeStatement(sql);
}

/** The methods that execute a statement. */
const EXECUTING: ReadonlySet<string | symbol> = new Set(["run", "get", "all", "iterate"]);

/** `statement` whose executions ask the mutex first. */
function guardedStatement(statement: object, sql: unknown, guards: StatementGuards): object {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (EXECUTING.has(property)) beforeStatement(guards, sql);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/**
 * `database` under the file's mutex (#1317c): no statement runs while another's `runOnce`
 * transaction is open (see `SqliteMutex.assertMayRun`) — prepared long ago or now.
 */
export function guardedDatabase(database: DatabaseSync, guards: StatementGuards): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (property === "exec") beforeStatement(guards, args[0]);
        const result: unknown = Reflect.apply(value, target, args);
        return property === "prepare" && typeof result === "object" && result !== null
          ? guardedStatement(result, args[0], guards)
          : result;
      };
    },
  });
}
