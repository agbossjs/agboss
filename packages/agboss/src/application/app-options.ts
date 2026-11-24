import type { CreateAppOptions } from "../app/create-app-options.js";
import { shownValueOf } from "../core/shown-value.js";

/** The options `createApp` takes (#834): a JavaScript caller's other keys are refused, never ignored. */
const APP_OPTIONS: readonly (keyof CreateAppOptions)[] = [
  "env",
  "profile",
  "meterProvider",
  "tracerProvider",
];

const REFUSED = "infrastructure and settings go in @Application({ … }), test seams in testWith";

const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

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
  return {
    ...(given.env === undefined ? {} : { env: given.env }),
    ...(given.profile === undefined ? {} : { profile: given.profile }),
    ...(given.meterProvider === undefined ? {} : { meterProvider: given.meterProvider }),
    ...(given.tracerProvider === undefined ? {} : { tracerProvider: given.tracerProvider }),
  };
}
