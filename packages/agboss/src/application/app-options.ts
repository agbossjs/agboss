import type { CreateAppOptions } from "../app/create-app-options.js";
import { shownValueOf } from "../core/shown-value.js";

/** The options `createApp` takes (#834): a JavaScript caller's other keys are refused, never ignored. */
const APP_OPTIONS: readonly (keyof CreateAppOptions)[] = [
  "profile",
  "meterProvider",
  "tracerProvider",
  "handleSignals",
  "processEnv",
];

const REFUSED = "infrastructure and settings go in @Application({ … }), test seams in testWith";

const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/** `handleSignals` is a boolean and `processEnv` an object of variables — a JavaScript caller's others are refused. */
function checkedProcessOptions(given: CreateAppOptions): void {
  if (given.handleSignals !== undefined && typeof given.handleSignals !== "boolean") {
    throw new TypeError(
      `createApp's handleSignals is true or false — not ${shownValueOf(given.handleSignals)}`,
    );
  }
  if (
    given.processEnv !== undefined &&
    !isPlainObject(given.processEnv) &&
    given.processEnv !== process.env
  ) {
    throw new TypeError(
      `createApp's processEnv is an object of variables, as process.env — not ${shownValueOf(given.processEnv)}`,
    );
  }
}

/**
 * `createApp`'s options as a fresh object of its keys only (#834) — so no seam reaches the
 * build through an inherited, a non-enumerable or a symbol key either.
 */
export function productionOptionsOf(options: unknown): CreateAppOptions {
  if (!isPlainObject(options)) {
    throw new TypeError(
      `createApp takes an object of ${APP_OPTIONS.join(", ")} — not ${shownValueOf(options)}: ${REFUSED}`,
    );
  }
  const unknown = Reflect.ownKeys(options)
    .filter((key) => typeof key !== "string" || !(APP_OPTIONS as readonly string[]).includes(key))
    .map(String);
  if (unknown.length > 0) {
    throw new TypeError(
      `createApp takes only ${APP_OPTIONS.join(", ")} — not ${unknown.join(", ")}: ${REFUSED}`,
    );
  }
  const given = options as CreateAppOptions;
  checkedProcessOptions(given);
  return {
    // a library takes no signals unasked (the CLI asks)
    handleSignals: given.handleSignals ?? false,
    ...(given.processEnv === undefined ? {} : { processEnv: given.processEnv }),
    ...(given.profile === undefined ? {} : { profile: given.profile }),
    ...(given.meterProvider === undefined ? {} : { meterProvider: given.meterProvider }),
    ...(given.tracerProvider === undefined ? {} : { tracerProvider: given.tracerProvider }),
  };
}
