/** #262 Q4: a thread's key is tenant + thread — a caller's own id in two tenants is two threads. */
import { describe, expect, it } from "vitest";
import {
  createSqliteTernStore,
  isThreadId,
  threadIdOf,
  threadKeyOf,
  type NewTern,
} from "../../src/terns/index.js";

const tern = (tenantId: string, task: string): NewTern => ({
  runId: "run-1",
  threadId: "order-7",
  tenantId,
  bundle: "b",
  task,
  replyWith: "ok",
  status: "answered",
  stopReason: "done",
  route: [],
  steps: [],
  costUsd: 0,
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: null,
  configHash: null,
});

describe("#262 Q4: thread keys", () => {
  it("the default tenant keeps the id as it is; another tenant's key names the tenant", () => {
    expect(threadKeyOf("default", "order-7")).toBe("order-7");
    expect(threadKeyOf("acme", "order-7")).toBe("acme\u001forder-7");
    expect(threadIdOf("acme", threadKeyOf("acme", "order-7"))).toBe("order-7");
    expect(threadIdOf("default", "order-7")).toBe("order-7");
  });

  it("a thread id: 1 to 200 characters, no control characters", () => {
    expect(isThreadId("order-7 / Ünïcode ✓")).toBe(true);
    expect(isThreadId("")).toBe(false);
    expect(isThreadId("x".repeat(201))).toBe(false);
    expect(isThreadId("a\u001fb")).toBe(false);
    expect(isThreadId("a\u007fb")).toBe(false);
  });

  it("one id in two tenants: two threads, two owners, two histories", async () => {
    const store = createSqliteTernStore(":memory:", () => new Date());

    await store.createThread("b", "acme", "alice", "order-7");
    await store.createThread("b", "globex", "bob", "order-7");
    await store.createThread("b", "acme", "mallory", "order-7"); // exists: kept as it is
    await store.append(tern("acme", "acme's turn"));
    await store.append(tern("globex", "globex's turn"));

    expect(await store.threadOwner("b", "acme", "order-7")).toEqual({ owner: "alice" });
    expect(await store.threadOwner("b", "globex", "order-7")).toEqual({ owner: "bob" });
    expect(await store.hasThread("b", "initech", "order-7")).toBe(false);
    const acme = await store.lastTerns(threadKeyOf("acme", "order-7"), 10);
    expect(acme.map((item) => [item.task, item.threadId])).toEqual([["acme's turn", "order-7"]]);
  });
});
