import type { AppOptions } from "../app/create-app.js";
import { shownValueOf } from "../core/shown-value.js";

/** The four options `createApp` takes (#834): a JavaScript caller's other keys are refused, never ignored. */
const APP_OPTIONS: readonly (keyof AppOptions)[] = [
  "env",
  "profile",
  "profileRoot",
  "meterProvider",
];

const REFUSED = "infrastructure and settings go in @Application({ … }), test seams in testWith";

const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/**
 * `createApp`'s options as a fresh object of its four keys only (#834) — so no seam reaches the
 * build through an inherited, a non-enumerable or a symbol key either.
 */
export function productionOptionsOf(options: unknown): AppOptions {
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
  const given = options as AppOptions;
  return {
    ...(given.env === undefined ? {} : { env: given.env }),
    ...(given.profile === undefined ? {} : { profile: given.profile }),
    ...(given.profileRoot === undefined ? {} : { profileRoot: given.profileRoot }),
    ...(given.meterProvider === undefined ? {} : { meterProvider: given.meterProvider }),
  };
}
