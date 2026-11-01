/**
 * #646 — `clock.advance` right after `app.execute`: the work already started reaches its next wait
 * on the clock before the time jumps, however many turns of the event loop getting there takes —
 * the first execution of a file loads the core's lazy modules on the way (through vite's module
 * runner, ~300 turns), and an execution of an app not built yet builds it first (loading its files
 * by path). Each is a load the clock waits for (`lazyLoad`, every dynamic import of the core —
 * lint-enforced).
 */
import { describe, expect, it } from "vitest";
import { lazyLoad } from "../../src/infrastructure/clock.js";
import { HealthComponentKind, HealthStatus, type HealthReport } from "../../src/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { replyWith, testWith, waitFor } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  BusySlotsApplication,
  ChunkDraftDto,
  ChunkWorkerAgent,
  ChunkWorkflowFinish,
  ChunkWorkflowStart,
} from "./fixtures/busy-slots.workflow.js";

const test = testWith(BusySlotsApplication);

const slotsOf = (report: HealthReport): HealthStatus | undefined =>
  report.components.find((component) => component.kind === HealthComponentKind.StepSlots)?.status;

/** Two chunks whose agents each wait 5 s on the clock in their model call, holding a step slot. */
const chunkTurns = [waitFor(seconds(5))] as const;
const CHUNKS = ["slot-1", "slot-2"] as const;

/** Resolves after `turns` turns of the event loop: a load that takes as long as a cold one. */
async function turnsOf(turns: number): Promise<string> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  return "loaded";
}

// first in the file: the core's lazy modules of an execution are not loaded yet
describe("#646 AC1: advance right after execute", () => {
  test("the app built, two executions started, advanced at once: both hold their slots", async ({
    app,
    clock,
    mockLlm,
  }) => {
    await app.ready();
    for (const chunk of CHUNKS) {
      mockLlm(ChunkWorkerAgent)
        .when({ task: { text: chunk } })
        .thenReturn(...chunkTurns, replyWith(ChunkDraftDto, { summary: `${chunk} done` }));
    }
    const first = execute(app, ChunkWorkflowStart, { text: "slot-1" });
    const second = execute(app, ChunkWorkflowStart, { text: "slot-2" });

    await clock.advance(seconds(1));
    const busy = await app.checkReadiness();
    await clock.advance(seconds(5));
    const done = await Promise.all([first, second]);

    expect(slotsOf(busy)).toBe(HealthStatus.Degraded);
    expect(done[0]).toFinishWith(ChunkWorkflowFinish, { summary: "slot-1 done" });
    expect(done[1]).toFinishWith(ChunkWorkflowFinish, { summary: "slot-2 done" });
  });

  test("the app not built yet: its first execute builds it, its files loaded by path, before the wait", async ({
    app,
    clock,
    mockLlm,
  }) => {
    for (const chunk of CHUNKS) {
      mockLlm(ChunkWorkerAgent)
        .when({ task: { text: chunk } })
        .thenReturn(...chunkTurns, replyWith(ChunkDraftDto, { summary: `${chunk} done` }));
    }
    const first = execute(app, ChunkWorkflowStart, { text: "slot-1" });
    const second = execute(app, ChunkWorkflowStart, { text: "slot-2" });

    await clock.advance(seconds(1));
    const busy = await app.checkReadiness();
    await clock.advance(seconds(5));
    const done = await Promise.all([first, second]);

    expect(slotsOf(busy)).toBe(HealthStatus.Degraded);
    expect(done.map((result) => result.finish)).toMatchObject([
      { name: "chunk-workflow-finish" },
      { name: "chunk-workflow-finish" },
    ]);
  });
});

describe("#646: advance waits for the core's lazy loads", () => {
  it("a load in flight settles before the time jumps, and the work after it reaches its wait", async () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    const work = (async () => {
      order.push(await lazyLoad(turnsOf(500)));
      await clock.sleep(seconds(1));
      order.push("woken");
    })();

    await clock.advance(seconds(1));
    await work;

    expect(order).toEqual(["loaded", "woken"]);
  });

  it("a load that fails is settled too: advance does not wait on it forever", async () => {
    const clock = new VirtualClock();
    const failed = lazyLoad(turnsOf(50).then(() => Promise.reject(new Error("no module"))));

    await clock.advance(seconds(1));

    await expect(failed).rejects.toThrow("no module");
  });
});
