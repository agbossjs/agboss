/**
 * #1366: what `a2aHttpListener` guarantees at its edges: a publicUrl with a query or fragment, and a
 * base not starting with "/" or ending with one, stop the listener (`[a2a.public-url-invalid]`,
 * `[a2a.base-invalid]`); the card's URL is the publicUrl without its trailing slashes plus the base;
 * a request the listener cannot build its binding for is answered `503` with the stable
 * `a2a.listener-failed` body (a destroyed socket when the headers are out), logged by its class or
 * its framework error's code, the failed binding is built again by the next request, and an app
 * that createApp did not build (no mesh settings or no execution control) is refused with
 * `[a2a.app-required]`.
 */
import { MESH_DEFAULTS } from "../../helpers/mesh-settings.js";
import { describe, expect, it } from "vitest";
import { a2aHttpListener } from "../../../src/a2a/a2a-http.js";
import { Clock } from "../../../src/infrastructure/clock.js";
import { LogLevel, Logger, type LogEntry } from "../../../src/infrastructure/logger.js";
import {
  rememberExecutionControl,
  type ExecutionControl,
} from "../../../src/app/execution-control.js";
import { rememberMeshSettings, type MeshSettings } from "../../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { testWith } from "../../../src/testing/index.js";
import { until } from "../../helpers/until.js";
import { BearerAuthenticator } from "../../a2a/fixtures/bearer-authenticator.js";
import { OrdersA2AExpose, OrdersApplication } from "../../a2a/fixtures/task.application.js";
import { A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { recordComponent } from "../../../src/components/metadata.js";
import { OrderWorkflowStart } from "../../infrastructure/fixtures/recovery.workflow.js";

@A2AExpose({ name: "flipped", version: "1.0.0", description: "d", exports: [OrderWorkflowStart] })
class FlippedExpose {}

class MemoryLogger extends Logger {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

class Boom extends RangeError {
  override name = "Boom";
}

interface Host {
  readonly app: Parameters<typeof a2aHttpListener>[0];
  readonly logger: MemoryLogger;
  /** How many times the app's contracts were read: once per build of the binding. */
  readonly builds: () => number;
}

/** A host's own app (not made by createApp): optionally given mesh settings and an execution control. */
function hostOf(given: { mesh: boolean; control: boolean }): Host {
  const logger = new MemoryLogger();
  const clock = new VirtualClock();
  const resolver = new BearerAuthenticator();
  let built = 0;
  const app: Host["app"] = {
    execute: () => Promise.reject(new Boom("not used")),
    resume: () => Promise.reject(new Boom("not used")),
    cancel: () => Promise.reject(new Boom("not used")),
    resolve: ((cls: unknown) => {
      if (cls === Logger) return logger;
      if (cls === Clock) return clock;
      if (cls === BearerAuthenticator) return resolver;
      throw new Boom("resolved");
    }) as never,
  };
  if (given.mesh) {
    const settings: MeshSettings = {
      application: "host",
      maxMeshHops: 4,
      keys: { peers: new Map() },
      ...MESH_DEFAULTS,
      clock,
      idempotencyRetention: 1,
      a2aTaskRetention: 1,
      a2aFileRetention: 1,
      a2aMessageRetention: 1,
      workflows: [],
      exposes: [OrdersA2AExpose, FlippedExpose],
      contracts: () => {
        built += 1;
        return Promise.reject(new Boom("contracts"));
      },
    };
    rememberMeshSettings(app, () => settings);
  }
  if (given.control) {
    const control: ExecutionControl = {
      cancelExecution: () => Promise.reject(new Boom("not used")),
      executionStateOf: () => Promise.reject(new Boom("not used")),
      claimExecutionId: () => Promise.reject(new Boom("not used")),
    };
    rememberExecutionControl(app, control);
  }
  return { app, logger, builds: () => built };
}

const listenerOn = (host: Host, more: { publicUrl?: string; base?: string } = {}) =>
  a2aHttpListener(host.app, {
    expose: OrdersA2AExpose,
    authenticator: BearerAuthenticator,
    publicUrl: "https://desk.example",
    ...more,
  });

/** A response that records what was written; `headersSent` as given. */
function responseOf(headersSent: boolean) {
  const seen = { status: 0, headers: {} as object, body: "", destroyed: 0, written: false };
  const res = {
    headersSent,
    writeHead(status: number, headers: object) {
      seen.status = status;
      seen.headers = headers;
      return res;
    },
    end(body: string) {
      seen.body = body;
      seen.written = true;
    },
    destroy() {
      seen.destroyed += 1;
    },
  };
  return { seen, res };
}

const refusal = (publicUrl: string, base = "") => {
  const host = hostOf({ mesh: true, control: true });
  return () => listenerOn(host, { publicUrl, base });
};

describe("#1366: the listener's URL checks", () => {
  it("a publicUrl with a query or a fragment is refused as public-url-invalid", () => {
    for (const url of ["https://desk.example/?a=1", "http://desk.example#top"]) {
      expect(refusal(url)).toThrow(/\[a2a\.public-url-invalid\].*without a query or fragment/u);
    }
    expect(refusal("https://desk.example/path")).not.toThrow();
  });

  it("a base must start with / and must not end with one", () => {
    for (const base of ["a2a", "/a2a/", "a2a/", "/"])
      expect(refusal("https://desk.example", base)).toThrow(/\[a2a\.base-invalid\]/u);
    expect(refusal("https://desk.example", "/a2a")).not.toThrow();
    expect(refusal("https://desk.example", "")).not.toThrow();
  });

  it("the timer problem of one listener is refused as timeout-invalid", () => {
    const host = hostOf({ mesh: true, control: true });
    const make = () =>
      a2aHttpListener(host.app, {
        expose: OrdersA2AExpose,
        authenticator: BearerAuthenticator,
        publicUrl: "https://desk.example",
        maxTaskDuration: 2_073_600_001 as never,
      });
    expect(make).toThrow(/\[a2a\.timeout-invalid\].*maxTaskDuration/su);
  });
});

describe("#1366: the card's URL", () => {
  const orders = testWith(OrdersApplication);

  orders("is the publicUrl without trailing slashes plus the base", async ({ a2aServer }) => {
    const { url } = await a2aServer({
      expose: OrdersA2AExpose,
      authenticator: BearerAuthenticator,
      publicUrl: "https://desk.example///",
      base: "/a2a",
    });

    const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as {
      supportedInterfaces: { url: string }[];
    };

    expect(card.supportedInterfaces.map((one) => one.url)).toEqual(["https://desk.example/a2a"]);
  });
});

describe("#1366: a request the listener cannot serve", () => {
  it("is answered 503 with the stable body, logged, and the binding is built again by the next request", async () => {
    const host = hostOf({ mesh: true, control: true });
    const listener = listenerOn(host);
    const first = responseOf(false);
    listener({} as never, first.res as never);
    await until(() => first.seen.written, "the first answer");

    expect(first.seen.status).toBe(503);
    expect(first.seen.headers).toMatchObject({ "content-type": "application/json" });
    const body = JSON.parse(first.seen.body) as { code: string; error: string };
    expect(body.code).toBe("a2a.listener-failed");
    expect(body.error.length).toBeGreaterThan(0);
    expect(first.seen.destroyed).toBe(0);
    expect(host.logger.entries).toHaveLength(1);
    // a failure of another class is logged by its class name, never its text
    expect(host.logger.entries[0]).toMatchObject({
      level: LogLevel.Error,
      code: "a2a.listener-failed",
    });
    expect(host.logger.entries[0]?.message).toContain("Boom");
    expect(host.logger.entries[0]?.message).not.toContain("contracts");

    const second = responseOf(false);
    listener({} as never, second.res as never);
    await until(() => second.seen.written, "the second answer");
    expect(host.builds()).toBe(2);
  });

  it("with the headers already out the socket is destroyed, nothing more is written", async () => {
    const host = hostOf({ mesh: true, control: true });
    const sent = responseOf(true);
    listenerOn(host)({} as never, sent.res as never);
    await until(() => sent.seen.destroyed > 0, "the destroyed socket");

    expect(sent.seen.destroyed).toBe(1);
    expect(sent.seen.written).toBe(false);
    expect(sent.seen.status).toBe(0);
  });

  it("an expose whose metadata is no longer an @A2AExpose's at the first request is refused as not-an-expose", async () => {
    const host = hostOf({ mesh: true, control: true });
    const listener = a2aHttpListener(host.app, {
      expose: FlippedExpose,
      authenticator: BearerAuthenticator,
      publicUrl: "https://desk.example",
    });
    // the listener checked the class when it was made; its metadata is replaced before the first request
    recordComponent(FlippedExpose, { kind: "a2a-agent", meta: {} } as never);
    const out = responseOf(false);
    listener({} as never, out.res as never);
    await until(() => out.seen.written, "the answer");

    expect(out.seen.status).toBe(503);
    expect(host.logger.entries[0]?.message).toContain("[a2a.not-an-expose]");
    expect(host.builds()).toBe(0);
  });

  it("an app made by no createApp (no mesh settings, or no execution control) is refused as app-required", async () => {
    for (const given of [
      { mesh: false, control: false },
      { mesh: true, control: false },
      { mesh: false, control: true },
    ]) {
      const host = hostOf(given);
      const out = responseOf(false);
      listenerOn(host)({} as never, out.res as never);
      await until(() => out.seen.written, "the answer");

      expect(out.seen.status).toBe(503);
      expect(host.logger.entries).toHaveLength(1);
      expect(host.logger.entries[0]?.message).toContain("[a2a.app-required]");
      expect(host.builds()).toBe(0);
    }
  });
});
