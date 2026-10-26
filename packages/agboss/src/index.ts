/**
 * `agboss` — the authoring API (#195): the component decorators and dependency injection, the
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
export * from "./public/app.js";
export * from "./public/infrastructure.js";
export * from "./public/mesh.js";
export * from "./errors.js";
