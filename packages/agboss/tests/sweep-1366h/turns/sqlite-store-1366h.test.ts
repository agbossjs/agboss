/**
 * #1366: the SQLite turn store — a version's summary carries its turns, scored count, mean score and spend (running
 * turns left out); a store made without an id generator mints distinct thread ids; `close` closes the connection.
 */
import { describe, expect, it } from "vitest";
import { createSqliteTurnStore, type NewTurn } from "../../../src/turns/index.js";

const turn = (overrides: Partial<NewTurn> = {}): NewTurn => ({
  runId: "run-1",
  threadId: "t",
  tenantId: "default",
  bundle: "b",
  task: "task",
  replyWith: "reply",
  status: "answered",
  stopReason: "done",
  route: ["alpha"],
  steps: [{ agent: "alpha", content: "reply" }],
  costUsd: 0.25,
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: null,
  configHash: null,
  ...overrides,
});

describe("#1366: a version's summary", () => {
  it("counts its turns and scores, averages the scores and adds the spend, version by version", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    const thread = await store.createThread({ workflow: "b", tenantId: "default" });
    const first = await store.append(turn({ threadId: thread, costUsd: 0.25 }));
    const second = await store.append(turn({ threadId: thread, costUsd: 0.5 }));
    await store.append(turn({ threadId: thread, promptVersion: "p2", costUsd: 1 }));
    await store.saveScore(first.id, "judge", 0.5);
    await store.saveScore(second.id, "judge", 1);

    const summary = await store.summary("b");

    expect(summary).toEqual([
      { promptVersion: "p1", turns: 2, scored: 2, meanScore: 0.75, costUsd: 0.75 },
      { promptVersion: "p2", turns: 1, scored: 0, meanScore: null, costUsd: 1 },
    ]);
    expect(await store.meanScore([first.id, second.id])).toBe(0.75);
    store.close();
  });
});

describe("#1366: a store without an id generator", () => {
  it("mints a distinct id for each new thread", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());

    const ids = [
      await store.createThread({ workflow: "b", tenantId: "default" }),
      await store.createThread({ workflow: "b", tenantId: "default" }),
    ];

    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    store.close();
  });
});

describe("#1366: closing the store", () => {
  it("closes its connection: nothing can be read from it afterwards", async () => {
    const store = createSqliteTurnStore(":memory:", () => new Date());
    await store.createThread({ workflow: "b", tenantId: "default" });

    store.close();

    expect(() => store.summary("b")).toThrow(Error);
  });
});
