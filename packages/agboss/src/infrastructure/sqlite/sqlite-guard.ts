import type { DatabaseSync } from "node:sqlite";
import type { SqliteMutex } from "./sqlite-mutex.js";

/** The methods that execute a statement. */
const EXECUTING: ReadonlySet<string | symbol> = new Set(["run", "get", "all", "iterate"]);

/** `statement` whose executions ask the mutex first. */
function guardedStatement(statement: object, mutex: SqliteMutex, owner: object): object {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (EXECUTING.has(property)) mutex.assertMayRun(owner);
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
): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (property === "exec") mutex.assertMayRun(owner);
        const result: unknown = Reflect.apply(value, target, args);
        return property === "prepare" && typeof result === "object" && result !== null
          ? guardedStatement(result, mutex, owner)
          : result;
      };
    },
  });
}
