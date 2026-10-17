import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { startComponents, stopComponents } from "../../src/components/container/lifecycle.js";
import { createMemoryLedger } from "../../src/finops/ledger.js";
import { WorkflowCancelledError } from "../../src/index.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  BrokenLifecycleWorkflow,
  events,
  gate,
  LifecycleWorkflow,
  ScoutAgent,
  SearchJobsTool,
  SearchWorkflowStart,
} from "./fixtures/lifecycle.workflow.js";
import { execute } from "../helpers/flow.js";

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

const search = testWith(LifecycleWorkflow);

describe("#261 AC3: lifecycle hooks — order", () => {
  search(
    "onInit (dependencies first) → onStart → onStop → the running execution → onDestroy (dependants first)",
    async ({ app, mockLlm }) => {
      mockLlm(ScoutAgent).thenReturn(callTool(SearchJobsTool, { text: "TS" }), replyWith("found"));

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

  it("after app.close() no new execution is accepted", async () => {
    const app = await createApp(LifecycleWorkflow, {
      gateway: createScriptedGateway(new ScriptBook()),
      stores: { terns: createSqliteTernStore(":memory:"), ledger: createMemoryLedger() },
    });

    await app.close();

    await expect(execute(app, SearchWorkflowStart, { text: "find jobs" })).rejects.toThrow(
      WorkflowCancelledError,
    );
    await expect(app.resume("thread-1", { approved: true })).rejects.toThrow("the app is stopping");
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
      createApp(BrokenLifecycleWorkflow, {
        gateway: createScriptedGateway(new ScriptBook()),
        stores: { terns: createSqliteTernStore(":memory:"), ledger: createMemoryLedger() },
      }),
    ).rejects.toThrow("[di.hook-failed] BrokenPoolProvider.onInit failed: no database at start");
  });
});
