/**
 * `@agboss/core` — the authoring API (#195): the component decorators and dependency injection, the
 * flow DSL and workflow settings, environments, observers, `createApp`, the errors and the public
 * types. Focused entries: `@agboss/core/dto`, `/units`, `/models`, `/testing`, and the integrations
 * `/mcp`, `/rag`, `/a2a`, `/memory`.
 *
 * Importing it has no side effects beyond the `Symbol.metadata` polyfill decorators need: tracing,
 * the MCP SDK, SQLite and `.env` are loaded only when an app uses them (tested in
 * tests/public-api/side-effects.test.ts). Wiki → Components.
 */
import "./polyfills/symbol-metadata.js";

export * from "./public/components.js";
export * from "./public/flow.js";
export * from "./public/observers.js";
export * from "./public/pause-notices.js";
export * from "./public/calendar.js";
export * from "./public/app.js";
export * from "./public/infrastructure.js";
// where the application's rows go (#1321)
export * from "./storage/index.js";
export * from "./public/mesh.js";
export type * from "./public/runtime-types.js";
export type * from "./public/dsl-types.js";
/** @beta Type machinery of the flow DSL and the decorators: not a contract, names may change. */
export type * as FlowTypes from "./public/flow-types.js";
export * from "./public/files.js";
export * from "./errors.js";
// the error families (#1325): each a type, a namespace of variants and a constructor
export * from "./core/error-families/config-errors.js";
export * from "./core/error-families/effect-errors.js";
export * from "./core/error-families/limit-errors.js";
export * from "./core/error-families/pause-errors.js";
export { ExecutionError, ExecutionErrorKind } from "./core/error-families/run-errors.js";
export { FileError, FileErrorKind } from "./core/error-families/remote-errors.js";
export * from "./core/error-families/step-errors.js";
export type {
  ErrorVariant,
  FamilyConstructor,
  PaidErrorVariant,
  PaidFacts,
  VariantCommon,
  VariantConstructor,
  VariantConstructors,
  VariantFacts,
  VariantOptions,
} from "./core/error-families/family.js";
export { Result, type ResultFactory, type TryOutcome } from "./core/result.js";
export * from "./infrastructure/store-call-timeout.js";
export {
  SqliteSchemaTooNewError,
  type SqliteSchemaTooNewErrorOptions,
} from "./infrastructure/sqlite/sqlite-schema-version.js";
export { Ttl } from "./units/index.js";
// `defineEnv` (#1324): the one reader of the process's variables
export {
  bearer,
  configureEnv,
  defineEnv,
  type BearerAuth,
  type EnvContract,
  type EnvOptions,
  type EnvOverrides,
  type EnvReader,
  type EnvReaders,
  type EnvRef,
  type EnvSpec,
  type EnvTtlOptions,
  type EnvValue,
  type InferEnv,
  type InferEnvValue,
  type OptionalSecretRef,
  type ReservedEnvKey,
  type SecretReader,
  type SecretRef,
} from "./environments/index.js";
