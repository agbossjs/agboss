import type { Class } from "../../components/injection.js";
import type { SqliteConnection } from "./sqlite-connection.js";

/** How a SQLite implementation's operations meet the file's mutex. */
export interface SqliteGateOptions {
  /** Methods served ahead of the queue (a single statement, harmless inside an open transaction). */
  readonly priority?: readonly string[];
  /** Priority methods that renew a lease: re-applied when the hold they rode in rolls back. */
  readonly renewals?: readonly string[];
  /** Methods that queue for the file themselves (`FencedEffectRepository.runInTransaction`). */
  readonly ungated?: readonly string[];
}

/** Members that are lifecycle hooks or the constructor: never queued. */
const NEVER_GATED: ReadonlySet<string> = new Set([
  "constructor",
  "onDestroy",
  "onInit",
  "onStart",
  "onStop",
]);

/** Marks a function that is already a gate: a subclass registered after its base is not wrapped twice. */
const GATED = Symbol("agboss.sqlite-gated");

type AnyFunction = (this: object, ...args: unknown[]) => unknown;

/**
 * Routes every operation of a SQLite implementation through its connection's mutex (#1317c): its
 * methods are wrapped on the prototype, so each runs at once when no `runOnce` transaction is open
 * on the file and else waits behind it — the 112 statements of the 20 repositories need no edit and
 * none can land inside another's transaction. The connection is the one the instance holds in a
 * field (an instance over a test double of it runs as it is).
 */
export function gatedSqliteImplementation(
  implementation: Class,
  options: SqliteGateOptions,
  connectionOf: (instance: object) => SqliteConnection | undefined,
): void {
  const { prototype } = implementation as { prototype: Record<string, unknown> };
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (NEVER_GATED.has(name) || options.ungated?.includes(name) === true) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const original = descriptor?.value as AnyFunction | undefined;
    if (typeof original !== "function" || GATED in original) continue;
    const gated = gatedMethod(original, flagsOf(options, name), connectionOf);
    Object.defineProperty(gated, GATED, { value: true });
    Object.defineProperty(gated, "name", { value: name });
    Object.defineProperty(prototype, name, { ...descriptor, value: gated });
  }
}

/**
 * The connection `instance` holds, or `undefined`: a test double standing in for it (an instance
 * built by hand over a stub connection, or one a test wraps in a proxy) is run as it is — every
 * implementation of the core keeps its `SqliteConnection` in a `connection` field.
 */
function connectionFor(
  instance: object,
  connectionOf: (instance: object) => SqliteConnection | undefined,
): SqliteConnection | undefined {
  return connectionOf(instance);
}

/** How a method meets the mutex: served ahead, and whether it renews a lease. */
function flagsOf(options: SqliteGateOptions, name: string) {
  return {
    isPriority: options.priority?.includes(name) === true,
    isRenewal: options.renewals?.includes(name) === true,
  };
}

/** `original` routed through its instance's connection (a stream waits its turn once, up front). */
function gatedMethod(
  original: AnyFunction,
  flags: ReturnType<typeof flagsOf>,
  connectionOf: (instance: object) => SqliteConnection | undefined,
): AnyFunction {
  if (original.constructor.name === "AsyncGeneratorFunction")
    return async function* (this: object, ...args: unknown[]) {
      await connectionFor(this, connectionOf)?.serve(() => undefined);
      yield* original.apply(this, args) as AsyncGenerator;
    };
  return function (this: object, ...args: unknown[]) {
    const connection = connectionFor(this, connectionOf);
    if (connection === undefined) return original.apply(this, args);
    return connection.gate(() => original.apply(this, args), flags);
  };
}
