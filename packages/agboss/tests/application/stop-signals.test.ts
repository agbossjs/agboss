/**
 * #265 S51: `createApp` listens for SIGTERM / SIGINT and calls `app.close()`; a second signal while
 * it stops interrupts at once; the listeners are removed when `close()` finishes; the signal is
 * then raised again when nothing else listens (the process ends as without the app); `testWith`
 * never listens.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { closeOnStopSignals, type StopSignalSource } from "../../src/application/stop-signals.js";
import type { CloseOptions } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { seconds } from "../../src/units/index.js";
import { DesksApplication } from "./fixtures/desks.application.js";

/** A process stand-in: its listeners, and the signals it was sent. */
class FakeProcess extends EventEmitter implements StopSignalSource {
  readonly pid = 4242;
  readonly sent: [number, NodeJS.Signals][] = [];

  kill(pid: number, signal: NodeJS.Signals): boolean {
    this.sent.push([pid, signal]);
    return true;
  }
}

/** An app whose close the test finishes by hand; every call's options kept. */
function closableApp(): {
  readonly app: { close: (options?: CloseOptions) => Promise<void> };
  readonly calls: (CloseOptions | undefined)[];
  readonly finish: () => Promise<void>;
  readonly closed: Promise<void>;
} {
  const calls: (CloseOptions | undefined)[] = [];
  let finish = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    app: {
      close: (options) => {
        calls.push(options);
        return closed;
      },
    },
    calls,
    closed,
    finish: async () => {
      finish();
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#265 S51: the stop signals", () => {
  it("SIGTERM closes the app; when it has closed, the listeners go and the signal is raised again", async () => {
    const source = new FakeProcess();
    const closable = closableApp();
    closeOnStopSignals(closable, source);

    source.emit("SIGTERM", "SIGTERM");
    const listening = [source.listenerCount("SIGTERM"), source.listenerCount("SIGINT")];
    await closable.finish();

    expect(closable.calls).toEqual([{}]);
    expect(listening).toEqual([1, 1]);
    expect([source.listenerCount("SIGTERM"), source.listenerCount("SIGINT")]).toEqual([0, 0]);
    expect(source.sent).toEqual([[4242, "SIGTERM"]]);
  });

  it("a second signal while the app stops interrupts at once", async () => {
    const source = new FakeProcess();
    const closable = closableApp();
    closeOnStopSignals(closable, source);

    source.emit("SIGINT", "SIGINT");
    source.emit("SIGINT", "SIGINT");
    await closable.finish();

    expect(closable.calls).toEqual([{}, { timeout: seconds(0) }]);
    expect(source.sent).toEqual([[4242, "SIGINT"]]);
  });

  it("with another listener for the signal, it is not raised again: the project handles it", async () => {
    const source = new FakeProcess();
    const own = vi.fn();
    source.on("SIGTERM", own);
    const closable = closableApp();
    closeOnStopSignals(closable, source);

    source.emit("SIGTERM", "SIGTERM");
    await closable.finish();

    expect(own).toHaveBeenCalledOnce();
    expect(source.sent).toEqual([]);
  });

  it("a close the project calls itself removes the listeners too, and raises nothing", async () => {
    const source = new FakeProcess();
    const closable = closableApp();
    closeOnStopSignals(closable, source);

    await closable.finish();

    expect(source.listenerCount("SIGTERM")).toBe(0);
    expect(source.sent).toEqual([]);
  });

  it("a close that fails on a signal is reported as a warning, not thrown", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const source = new FakeProcess();
    let failed = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const app = { close: () => Promise.reject(new Error("a hook failed")) };
    closeOnStopSignals({ app, closed }, source);

    source.emit("SIGTERM", "SIGTERM");
    failed();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("a hook failed"), {
      code: "app.close-failed",
    });
  });
});

describe("#265 S51: who listens", () => {
  it("createApp listens on the process until close() finishes", async () => {
    const before = process.listenerCount("SIGTERM");
    const app = await createApp(DesksApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });
    const listening = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];

    await app.close();

    expect(listening[0]).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  testWith(DesksApplication)("testWith never listens", async ({ app }) => {
    const before = process.listenerCount("SIGTERM");

    await app.ready();

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
