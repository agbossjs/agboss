import type { DatabaseSync } from "node:sqlite";
import type { CleanAttempt } from "./sqlite-attempt.js";
import type { SqliteMutex } from "./sqlite-mutex.js";

/** The methods that execute a statement. */
const EXECUTING: ReadonlySet<string | symbol> = new Set(["run", "get", "all", "iterate"]);

/** `statement` whose executions ask the mutex first. */
function guardedStatement(
  statement: object,
  sql: unknown,
  mutex: SqliteMutex,
  owner: object,
  attempt: CleanAttempt,
): object {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (EXECUTING.has(property)) {
          mutex.assertMayRun(owner);
          if (typeof sql === "string") attempt.beforeStatement(sql);
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/**
 * `database` under the file's mutex (#1317c): no statement runs while another's `runOnce`
 * transaction is open (see `SqliteMutex.assertMayRun`) — prepared long ago or now.
 */
export function guardedDatabase(
  database: DatabaseSync,
  mutex: SqliteMutex,
  owner: object,
  attempt: CleanAttempt,
): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (property === "exec") {
          mutex.assertMayRun(owner);
          if (typeof args[0] === "string") attempt.beforeStatement(args[0]);
        }
        const result: unknown = Reflect.apply(value, target, args);
        return property === "prepare" && typeof result === "object" && result !== null
          ? guardedStatement(result, args[0], mutex, owner, attempt)
          : result;
      };
    },
  });
}
