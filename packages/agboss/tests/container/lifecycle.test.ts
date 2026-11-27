import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  startComponents,
  stopComponents,
  withinBound,
} from "../../src/components/container/lifecycle.js";
import { ApplicationStoppingError } from "../../src/index.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import type { AnyTenantApp as App } from "../../src/app/types.js";
import {
  Ask,
  rejections,
  resetEvents,
  ApplicationsApplication,
} from "../app/fixtures/run-events.workflow.js";
import { createSqliteTurnStore } from "../../src/turns/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  events,
  gate,
  ScoutAgent,
  SearchJobsTool,
  SearchWorkflowStart,
  BrokenLifecycleApplication,
  LifecycleApplication,
} from "./fixtures/lifecycle.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

beforeEach(() => {
  events.length = 0;
  gate.shut();
});

/** A component whose hooks log `<name>.<hook>`, or throw for the hooks in `failing`. */
const component = (log: string[], name: string, ...failing: string[]): Record<string, () => void> =>
  Object.fromEntries(
    ["onInit", "onStart", "onStop", "onDestroy"].map((hook) => [
      hook,
      () => {
        if (failing.includes(hook)) throw new Error(`${name} broke`);
        log.push(`${name}.${hook}`);
      },
    ]),
  );

/** An instance of a class called `name`: the error names the component by its class. */
const named = (name: string, hooks: Record<string, () => void>): object => {
  const classes: Record<string, new () => object> = {
    [name]: class {
      readonly label = name;
    },
  };
  const cls = classes[name] ?? Object;
  return Object.assign(new cls(), hooks);
};

const search = testWith(LifecycleApplication);

describe("#261 AC3: lifecycle hooks — order", () => {
  search(
    "onInit (dependencies first) → onStart → onStop → the running execution → onDestroy (dependants first)",
    async ({ app, mockModel }) => {
      mockModel(ScoutAgent).thenReturn(
        callTool(SearchJobsTool, { text: "TS" }),
        replyWith("found"),
      );

      const running = execute(app, SearchWorkflowStart, { text: "find jobs" });
      await gate.entered;
      const closing = app.close();
      await Promise.resolve();
      gate.open();
      await Promise.all([running, closing]);

      expect(events).toEqual([
        "ConnectionPoolProvider.onInit",
        "JobIndexService.onInit",
        "ConnectionPoolProvider.onStart",
        "JobIndexService.onStart",
        "search started",
        "JobIndexService.onStop",
        "ConnectionPoolProvider.onStop",
        "search finished",
        "JobIndexService.onDestroy",
        "ConnectionPoolProvider.onDestroy",
      ]);
    },
  );
});

/** An app of the lifecycle workflow, the scout scripted to search once and answer. */
const scriptedApp = async (): Promise<App> => {
  const book = new ScriptBook();
  book
    .scriptOf("agent:scout-agent")
    .thenReturn(callTool(SearchJobsTool, { text: "TS" }), replyWith("found"));
  return createTestAppWith(LifecycleApplication, { gateway: createScriptedGateway(book) });
};

/** An app whose observer records the refused requests. */
const observedApp = (): Promise<App> =>
  createTestAppWith(ApplicationsApplication, {
    gateway: createScriptedGateway(new ScriptBook()),
  });

describe("#261 AC3: after app.close() no new execution is accepted", () => {
  beforeEach(resetEvents);

  it("execute after close rejects with ApplicationStoppingError (app.stopping)", async () => {
    const app = await observedApp();
    await app.close();

    const refused = execute(app, Ask, { text: "secret question" });

    await expect(refused).rejects.toBeInstanceOf(ApplicationStoppingError);
    await expect(refused).rejects.toMatchObject({ code: "app.stopping" });
  });

  it("resume after close rejects with ApplicationStoppingError", async () => {
    const app = await observedApp();
    await app.close();

    await expect(
      app.resume({ pauseId: "pause-1", decision: { approved: true } }),
    ).rejects.toBeInstanceOf(ApplicationStoppingError);
  });

  it("the observer gets onRunRejected with app.stopping, its operation, no input values", async () => {
    const app = await observedApp();
    await app.close();

    await execute(app, Ask, { text: "secret question" }).catch(() => undefined);
    await app.resume({ pauseId: "pause-1", decision: { approved: true } }).catch(() => undefined);

    expect(rejections.map(({ operation, code }) => ({ operation, code }))).toEqual([
      { operation: "execute", code: "app.stopping" },
      { operation: "resume", code: "app.stopping" },
    ]);
    expect(rejections[1]?.threadId).toBeUndefined();
    expect(JSON.stringify(rejections)).not.toContain("secret question");
  });

  it("cancel still works while the app stops: the running execution is aborted", async () => {
    const app = await scriptedApp();
    const running = execute(app, SearchWorkflowStart, { text: "find jobs" }, { threadId: "t-1" });
    await gate.entered;

    const closing = app.close();
    const cancelled = await app.cancel("t-1");
    gate.open();

    expect(cancelled).toEqual({ cancelled: true });
    await expect(running).resolves.toMatchObject({ status: ExecutionStatus.Cancelled });
    await closing;
  });
});

describe("#261 AC3: lifecycle hooks — errors", () => {
  it("a failing onInit stops the start, names the component and the hook; the started ones are destroyed", async () => {
    const log: string[] = [];
    const instances = [
      named("ConnectionPoolProvider", component(log, "pool")),
      named("JobIndexService", component(log, "index", "onInit")),
      named("JobCacheService", component(log, "cache")),
    ];

    await expect(startComponents(instances)).rejects.toThrow(
      "[di.hook-failed] JobIndexService.onInit failed: index broke",
    );
    expect(log).toEqual(["pool.onInit", "pool.onDestroy"]);
  });

  it("a failing onStart stops the start too", async () => {
    const log: string[] = [];
    const instances = [
      named("ConnectionPoolProvider", component(log, "pool", "onStart")),
      named("JobIndexService", component(log, "index")),
    ];

    await expect(startComponents(instances)).rejects.toThrow(
      "[di.hook-failed] ConnectionPoolProvider.onStart failed: pool broke",
    );
    expect(log).toEqual(["pool.onInit", "index.onInit", "index.onDestroy", "pool.onDestroy"]);
  });

  it("stop waits for the executions; failing onStop / onDestroy let the others run, collected into one error", async () => {
    const log: string[] = [];
    const instances = [
      named("ConnectionPoolProvider", component(log, "pool", "onDestroy")),
      named("JobIndexService", component(log, "index", "onStop")),
      { plain: true },
    ];

    const stopping = stopComponents(instances, () => {
      log.push("executions done");
      return Promise.resolve();
    });

    await expect(stopping).rejects.toThrow(
      "2 lifecycle hook(s) failed: [di.hook-failed] JobIndexService.onStop failed: index broke; [di.hook-failed] ConnectionPoolProvider.onDestroy failed: pool broke",
    );
    await expect(stopping).rejects.toBeInstanceOf(AggregateError);
    expect(log).toEqual(["pool.onStop", "executions done", "index.onDestroy"]);
  });

  it("a failing onInit of a real component: the app does not start, the error names it", async () => {
    await expect(
      createTestAppWith(BrokenLifecycleApplication, {
        gateway: createScriptedGateway(new ScriptBook()),
      }),
    ).rejects.toThrow("[di.hook-failed] BrokenPoolProvider.onInit failed: no database at start");
  });

  // #954: the stop's end passed before the connection's onDestroy even began (a sweep's unanswered
  // store call used the deadline) — its orderly close is abandoned, its socket is destroyed at once
  describe("onAbandon (#954)", () => {
    const bound = (aborted: boolean) => {
      const ended = new AbortController();
      if (aborted) ended.abort();
      const abandoned: string[] = [];
      return {
        ended,
        abandoned,
        stop: {
          signal: ended.signal,
          abandon: (what: string) => abandoned.push(what),
        },
      };
    };
    const hanging = (log: string[]) => ({
      onDestroy: () => {
        log.push("onDestroy");
        return new Promise<void>(() => undefined);
      },
      onAbandon: () => {
        log.push("onAbandon");
      },
    });

    it("the deadline already passed behind a hanging phase: onAbandon runs before the stop returns", async () => {
      const log: string[] = [];
      const { stop, abandoned } = bound(true);

      await stopComponents([named("RedisConnection", hanging(log))], undefined, stop);

      expect(log).toEqual(["onDestroy", "onAbandon"]);
      expect(abandoned).toEqual(["onDestroy of RedisConnection"]);
    });

    it("the deadline passes while onDestroy waits: onAbandon runs then", async () => {
      const log: string[] = [];
      const { stop, ended } = bound(false);

      const stopping = stopComponents([named("RedisConnection", hanging(log))], undefined, stop);
      await new Promise((resolve) => setImmediate(resolve));
      expect(log).toEqual(["onDestroy"]);
      ended.abort();
      await stopping;

      expect(log).toEqual(["onDestroy", "onAbandon"]);
    });

    it("onDestroy returned in time: onAbandon is not called", async () => {
      const log: string[] = [];
      const { stop } = bound(false);
      const done = {
        onDestroy: () => {
          log.push("onDestroy");
        },
        onAbandon: () => {
          log.push("onAbandon");
        },
      };

      await stopComponents([named("RedisConnection", done)], undefined, stop);

      expect(log).toEqual(["onDestroy"]);
    });

    const never = () => new Promise<void>(() => undefined);

    it("an abandoned onStop (or onBeforeDestroy) does not call onAbandon; an abandoned onDestroy does", async () => {
      const log: string[] = [];
      const instance = { onAbandon: () => log.push("onAbandon") };
      const { stop } = bound(true);
      const told = new WeakSet<object>();

      await withinBound(never(), stop, { hook: "onStop", instance, told });
      await withinBound(never(), stop, { hook: "onBeforeDestroy", instance, told });
      expect(log).toEqual([]);

      await withinBound(never(), stop, { hook: "onDestroy", instance, told });
      expect(log).toEqual(["onAbandon"]);
    });

    it("onAbandon runs at most once per instance, though several of its hooks are abandoned", async () => {
      const log: string[] = [];
      const instance = { onAbandon: () => log.push("onAbandon") };
      const { stop } = bound(true);
      const told = new WeakSet<object>();

      await withinBound(never(), stop, { hook: "onDestroy", instance, told });
      await withinBound(never(), stop, { hook: "onDestroy", instance, told });

      expect(log).toEqual(["onAbandon"]);
    });

    it("a throwing onAbandon is dropped; the other hooks still run", async () => {
      const log: string[] = [];
      const { stop } = bound(true);
      const broken = {
        ...hanging(log),
        onAbandon: () => {
          throw new Error("already closed");
        },
      };

      await stopComponents(
        [named("RedisConnection", broken), named("Other", component(log, "other"))],
        undefined,
        stop,
      );

      expect(log).toContain("other.onDestroy");
    });
  });
});
