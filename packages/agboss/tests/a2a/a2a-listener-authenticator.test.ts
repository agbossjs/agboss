/**
 * #1320: `a2aHttpListener` needs an `@HttpAuthenticator` only when the application declares a
 * `tenantContext` of its own; without it (the base one) a caller that is no signed peer is anonymous.
 * With a `tenantContext` and no authenticator the listener is not made: a `ConfigError`
 * (`[http.authenticator-required-for-tenant-context]`), never a `ComponentError`.
 */
import { describe, expect, it } from "vitest";
import { a2aHttpListener } from "../../src/a2a/a2a-http.js";
import { ownedTask } from "../../src/a2a/server/a2a-server-parts.js";
import { externalCallerOf } from "../../src/a2a/server/a2a-peer-gate.js";
import { ComponentError } from "../../src/components/metadata.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { Logger, SilentLogger } from "../../src/infrastructure/logger.js";
import { rememberMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { MESH_DEFAULTS } from "../helpers/mesh-settings.js";
import { OrdersA2AExpose } from "./fixtures/task.application.js";

function appOf(isBaseTenantContext: boolean): Parameters<typeof a2aHttpListener>[0] {
  const clock = new VirtualClock();
  const settings: MeshSettings = {
    application: "host",
    maxMeshHops: 4,
    keys: { peers: new Map() },
    ...MESH_DEFAULTS,
    isBaseTenantContext,
    clock,
    idempotencyRetention: 1,
    workflows: [],
    endpoints: [OrdersA2AExpose],
    contracts: () => Promise.reject(new Error("not used")),
  };
  const app = {
    resolve: ((token: unknown) => (token === Logger ? new SilentLogger() : clock)) as never,
  } as never;
  rememberMeshSettings(app, () => settings);
  return app;
}

const options = { endpoint: OrdersA2AExpose, publicUrl: "https://desk.example" };

describe("#1320: the A2A listener's authenticator", () => {
  it("is optional for an application with no tenantContext of its own", () => {
    expect(() => a2aHttpListener(appOf(true), options)).not.toThrow();
  });

  it("is required with a tenantContext: a ConfigError, not a ComponentError", () => {
    const made = () => a2aHttpListener(appOf(false), options);

    expect(made).toThrow(ConfigError.Option);
    expect(made).toThrow("[http.authenticator-required-for-tenant-context]");
    expect(made).not.toThrow(ComponentError);
  });

  it("two anonymous callers are two owners: each bound to its own connection", async () => {
    const binding = { authenticator: undefined } as never;
    const socketA = {};
    const socketB = {};
    const callerOn = async (socket: object) => {
      const gate = await externalCallerOf(binding, { req: { socket }, res: {} } as never);
      return gate.isAdmitted ? gate.caller.ownerId : undefined;
    };

    const a = await callerOn(socketA);

    expect(a).toMatch(/^anonymous:/);
    expect(await callerOn(socketA)).toBe(a);
    expect(await callerOn(socketB)).not.toBe(a);
  });

  it("a task is another owner's, or no owner's, is not found: get, cancel, subscribe, list share this gate", async () => {
    const task = { tenantId: "t", taskId: "k1", ownerId: "anonymous:a", endpoint: "e" };
    const parts = {
      endpoint: "e",
      tasks: { findById: () => Promise.resolve(task) },
    } as never;
    const ask = (ownerId: string | undefined) =>
      ownedTask(parts, { tenantId: "t", ownerId } as never, "k1");

    await expect(ask("anonymous:b")).rejects.toThrow();
    await expect(ask(undefined)).rejects.toThrow();
  });
});
