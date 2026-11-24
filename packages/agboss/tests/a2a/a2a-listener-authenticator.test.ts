/**
 * #1320: `a2aHttpListener` serves callers no authenticator vouches for only with `allowAnonymous:
 * true`, only in an application with no `tenantContext` of its own, and not beside an authenticator;
 * else the listener is not made: a `ConfigError` (`[http.authenticator-required-for-tenant-context]`),
 * never a `ComponentError`. An anonymous caller owns nothing and is bound to nothing of its
 * connection: its task is reached by its id, and listing is `403`.
 */
import { describe, expect, it } from "vitest";
import { a2aHttpListener } from "../../src/a2a/a2a-http.js";
import { ownedTask } from "../../src/a2a/server/a2a-server-parts.js";
import { A2AOperation } from "../../src/a2a/a2a-caller.js";
import { forNewTask, forTask } from "../../src/a2a/server/a2a-server-parts.js";
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
const CODE = "[http.authenticator-required-for-tenant-context]";

describe("#1320: the A2A listener's authenticator", () => {
  it("is required unless allowAnonymous is set: a forgotten one is a ConfigError, not a ComponentError", () => {
    const made = () => a2aHttpListener(appOf(true), options);

    expect(made).toThrow(ConfigError.Option);
    expect(made).toThrow(CODE);
    expect(made).not.toThrow(ComponentError);
  });

  it("allowAnonymous: true serves an application with no tenantContext of its own", () => {
    expect(() => a2aHttpListener(appOf(true), { ...options, allowAnonymous: true })).not.toThrow();
  });

  it("with a tenantContext: no authenticator is a ConfigError, and so is allowAnonymous", () => {
    const forgotten = () => a2aHttpListener(appOf(false), options);
    const anonymous = () => a2aHttpListener(appOf(false), { ...options, allowAnonymous: true });

    expect(forgotten).toThrow(ConfigError.Option);
    expect(forgotten).toThrow(CODE);
    expect(anonymous).toThrow(ConfigError.Option);
    expect(anonymous).toThrow(CODE);
  });

  it("allowAnonymous and an authenticator exclude each other", () => {
    const both = () =>
      a2aHttpListener(appOf(true), {
        ...options,
        allowAnonymous: true,
        authenticator: OrdersA2AExpose,
      });

    expect(both).toThrow(ConfigError.Option);
    expect(both).toThrow(CODE);
  });

  it("an anonymous caller is none's: the same on every connection, no owner made from a socket", async () => {
    const binding = { allowAnonymous: true } as never;
    const callerOn = async (socket: object) => {
      const gate = await externalCallerOf(binding, {
        req: { socket },
        res: {},
        operation: A2AOperation.GetTask,
      } as never);
      return gate.isAdmitted ? gate.caller : undefined;
    };

    expect(await callerOn({})).toEqual({});
    expect(await callerOn({})).toEqual({});
  });

  it("with no authenticator and no allowAnonymous only a signed peer is served: others are 401", async () => {
    const written: unknown[] = [];
    const res = {
      writeHead: (status: number) => ({ end: (body: string) => written.push([status, body]) }),
    };

    const gate = await externalCallerOf(
      {} as never,
      {
        req: {},
        res,
        operation: A2AOperation.GetTask,
      } as never,
    );

    expect(gate.isAdmitted).toBe(false);
    expect(written).toEqual([[401, expect.stringContaining("a2a.caller-unauthenticated")]]);
  });

  it("listing is 403 for a caller that names no owner, anonymous or a tenant's key", async () => {
    const written: unknown[] = [];
    const res = {
      writeHead: (status: number) => ({ end: (body: string) => written.push([status, body]) }),
    };
    const listing = { req: {}, res, operation: A2AOperation.ListTasks } as never;

    const gate = await externalCallerOf({ allowAnonymous: true } as never, listing);

    expect(gate.isAdmitted).toBe(false);
    expect(written).toEqual([[403, expect.stringContaining("a2a.list-forbidden")]]);
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

  it("a caller with no owner gets one of its own for each new task, and the task's id is the right to it", async () => {
    const asked = { tenantId: "t", ownerId: undefined, caller: {} } as never;
    const first = forNewTask(asked);
    const second = forNewTask(asked);
    const task = { tenantId: "t", taskId: "k1", ownerId: first.ownerId, endpoint: "e" };
    const parts = {
      endpoint: "e",
      tasks: { findById: () => Promise.resolve(task) },
    } as never;

    expect(first.ownerId).toMatch(/^a2a-task:/);
    expect(first.ownerId).not.toBe(second.ownerId);
    expect((await forTask(parts, asked, "k1")).ownerId).toBe(first.ownerId);
    // a task of a host's own owner is not reached by its id alone
    const hosts = {
      tasks: { findById: () => Promise.resolve({ ...task, ownerId: "dana" }) },
      endpoint: "e",
    } as never;
    expect((await forTask(hosts, asked, "k1")).ownerId).toBeUndefined();
    // a caller that names its owner keeps it
    const named = { tenantId: "t", ownerId: "dana", caller: {} } as never;
    expect(forNewTask(named).ownerId).toBe("dana");
  });

  it("the task id opens only a task of an a2a-task: owner: not an anonymous: or mcp-session: one", async () => {
    const asked = { tenantId: "t", ownerId: undefined, caller: {} } as never;
    const partsOf = (ownerId: string, tenantOfTask = "t") =>
      ({
        endpoint: "e",
        tasks: {
          findById: ({ tenantId }: { tenantId: string }) =>
            Promise.resolve(
              tenantId === tenantOfTask
                ? { tenantId, taskId: "k1", ownerId, endpoint: "e" }
                : undefined,
            ),
        },
      }) as never;

    for (const foreign of ["anonymous:x", "mcp-session:x"]) {
      expect((await forTask(partsOf(foreign), asked, "k1")).ownerId).toBeUndefined();
      await expect(
        ownedTask(partsOf(foreign), { tenantId: "t", ownerId: undefined } as never, "k1"),
      ).rejects.toThrow();
    }
    expect((await forTask(partsOf("a2a-task:x"), asked, "k1")).ownerId).toBe("a2a-task:x");
    // a capability of tenant t does not open under tenant u
    const other = { tenantId: "u", ownerId: undefined, caller: {} } as never;
    expect((await forTask(partsOf("a2a-task:x"), other, "k1")).ownerId).toBeUndefined();
  });
});
