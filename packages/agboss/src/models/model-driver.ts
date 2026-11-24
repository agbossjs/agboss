import type { EnvRef, OptionalSecretRef, SecretRef } from "../environments/env-ref.js";
import type { ProviderHandler } from "./handler.js";
import type { ModelKind } from "./model-kind.js";

/**
 * A model driver (#1313): the value `@ModelProvider({ driver })` takes — what
 * `OpenAiCompatibleDriver({ baseUrl, apiKey })`, `OpenRouterDriver({ apiKey })` and
 * `DecisionsDriver({ baseUrl })` return. It carries the protocol (`kind`: chat or decisions), the
 * connection settings with their `env(…)` / `secret(…)` references still in them (read once, at
 * start); the handler that speaks the protocol is kept internally. Built only by `defineModelDriver`, so a literal
 * is not a driver.
 */

declare const driverBrand: unique symbol;

/** A setting that is a text, or an `env(…)` reference to one. */
export type TextSetting = string | EnvRef<string>;

/** The headers a driver adds to every request: a value is a text, an `env(…)` or a `secret(…)`. */
export type DriverHeaders = Readonly<Record<string, TextSetting | SecretRef | OptionalSecretRef>>;

/** The connection settings every driver takes. */
export interface DriverConnectionSettings {
  /** The server's base URL (`https://api.openai.com/v1`), a text or an `env(…)`. */
  readonly baseUrl: TextSetting;
  /** The key sent as `Authorization: Bearer …`; omit for a server without one (a local vLLM, Ollama). */
  readonly apiKey?: SecretRef | OptionalSecretRef;
  /** Headers added to every request (a gateway's tenant header, a proxy's token). */
  readonly headers?: DriverHeaders;
}

/** What a driver was given, as it is kept: the settings (never read as text) and what they are for. */
export interface ModelDriverSettings {
  readonly baseUrl: TextSetting;
  readonly apiKey?: SecretRef | OptionalSecretRef | undefined;
  readonly headers?: DriverHeaders | undefined;
}

/** One model driver for the kind `TKind`. */
export interface ModelDriver<TKind extends ModelKind = ModelKind> {
  readonly [driverBrand]: true;
  /** Chat (`complete` / `chat`) or decisions (`decide`). */
  readonly kind: TKind;
  /** The protocol's name: `openai-compatible`, `openrouter`, `decisions`. */
  readonly dialect: string;
  /** Its connection settings; resolved with the process's variables when the application starts. */
  readonly settings: ModelDriverSettings;
  /** A line for `agboss describe`: where it points, never a secret. */
  readonly describes: string;
}

/** What a driver package gives `defineModelDriver`: the driver's fields and the handler that speaks the protocol. */
export type ModelDriverSpec<TKind extends ModelKind> = Omit<
  ModelDriver<TKind>,
  typeof driverBrand
> & {
  readonly handler: ProviderHandler;
};

const DRIVERS = new WeakSet<object>();
const HANDLERS = new WeakMap<object, ProviderHandler>();

/** The handler that speaks a driver's protocol over a connection (internal: no public type names it). */
export const driverHandlerOf = (driver: ModelDriver): ProviderHandler => {
  const handler = HANDLERS.get(driver);
  if (handler === undefined) throw new TypeError("not a model driver");
  return handler;
};

/** Makes a driver: what `OpenAiCompatibleDriver(…)` and the other drivers return. */
export function defineModelDriver<TKind extends ModelKind>(
  spec: ModelDriverSpec<TKind>,
): ModelDriver<TKind> {
  const { handler, ...fields } = spec;
  const driver = Object.freeze(fields) as ModelDriver<TKind>;
  DRIVERS.add(driver);
  HANDLERS.set(driver, handler);
  return driver;
}

/** Whether `value` was made by `defineModelDriver`. */
export const isModelDriver = (value: unknown): value is ModelDriver =>
  typeof value === "object" && value !== null && DRIVERS.has(value);

/** A chat driver. */
export type ChatModelDriver = ModelDriver<ModelKind.Chat>;
/** A decisions driver. */
export type DecisionsModelDriver = ModelDriver<ModelKind.Decisions>;
