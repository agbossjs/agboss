import { hours } from "../../../src/units/index.js";
/**
 * #1256: the fetches of files by url a listener has in flight at once are bounded across messages —
 * a slot per fetch, a bounded queue for the rest, the wait part of the fetch timeout, the overflow a
 * stable refusal.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import {
  FilePolicy,
  filePolicyViolations,
  type FileFetchPool,
} from "../../../src/files/file-policy.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { fetchedFile, type FileFetch } from "../../../src/a2a/files/a2a-file-fetch.js";
import {
  DEFAULT_MAX_CONCURRENT_FILE_FETCHES,
  DEFAULT_MAX_CONCURRENT_PER_OWNER,
  DEFAULT_MAX_QUEUED_PER_OWNER,
  FileFetchSlots,
  callerKeyOf,
  fileSlotsOf,
  tenantKeyOf,
  type FileCaller,
} from "../../../src/a2a/files/a2a-file-slots.js";
import type { FileHttpResponse } from "../../../src/a2a/files/a2a-file-transport.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { kilobytes, seconds } from "../../../src/units/index.js";
import { withFileTransport } from "../../../src/a2a/files/a2a-file-seam.js";
import type { FileTransport } from "../../../src/a2a/files/a2a-file-transport.js";
import { testWith, type A2AServerFixture } from "../../../src/testing/index.js";
import { until } from "../../helpers/until.js";
import { BearerAuthenticator } from "../fixtures/bearer-authenticator.js";
import {
  FILE_ORIGIN,
  FileCallerChannel,
  FilesA2AExpose,
  fileReviewFlow,
} from "../fixtures/files.application.js";
import { rpc } from "../server/rpc.js";
import { fileMessage, PDF, scriptedTransport, urlPart } from "./support.js";

const ORIGIN = "https://files.example";

/** A transport whose every fetch waits for the test to answer it; it counts the fetches it holds. */
function heldTransport() {
  const asked: string[] = [];
  const answers: (() => void)[] = [];
  const transport: FileFetch["transport"] = (url, signal) => {
    asked.push(url.href);
    return new Promise<FileHttpResponse>((resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
      answers.push(() => {
        resolve({
          status: 200,
          location: undefined,
          body: (async function* () {
            await Promise.resolve();
            yield PDF;
          })(),
          cancel: () => undefined,
        });
      });
    });
  };
  return { transport, asked, answer: (at: number) => answers[at]?.() };
}

const fetchOf = (
  transport: FileFetch["transport"],
  slots: FileFetchSlots,
  name: string,
  more: Partial<FileFetch> = {},
): FileFetch => ({
  url: `${ORIGIN}/${name}`,
  allowedOrigins: [ORIGIN],
  maxBytes: kilobytes(64),
  transport,
  clock: new VirtualClock(new Date("2026-01-05T09:00:00.000Z")),
  timeout: seconds(10),
  signal: new AbortController().signal,
  slots,
  ...more,
});

/** Slots whose one caller may hold them all: only the global bounds count. */
const slotsOf = (limit: number, queued: number): FileFetchSlots =>
  new FileFetchSlots(limit, queued, { running: limit, queued }, { running: limit, queued });

/** A share that never binds: the level under test is the other one. */
const WIDE = { running: 1000, queued: 1000 };

/** A caller of a tenant, with an owner or, with none, the tenant's share alone (#1339). */
const callerOf = (tenant: string, owner?: string): FileCaller => ({
  tenant: tenantKeyOf(tenant),
  owner: callerKeyOf(tenant, owner),
});

const settled = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return "fetched";
  } catch (error) {
    return Reflect.get(Object(Reflect.get(Object(error), "errorInfo") ?? error), "metadata");
  }
};

const turns = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe("#1256: FileFetchSlots", () => {
  it("the default is 16 at once", () => {
    expect(DEFAULT_MAX_CONCURRENT_FILE_FETCHES).toBe(16);
  });

  it("at most `limit` fetches run; a slot freed starts the next in line, in order", async () => {
    const held = heldTransport();
    const slots = slotsOf(2, 10);

    const all = ["a", "b", "c", "d"].map((name) =>
      fetchedFile(fetchOf(held.transport, slots, name)),
    );
    await turns();
    expect(held.asked).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`]);

    held.answer(0);
    await turns();
    expect(held.asked).toEqual([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`]);
    held.answer(1);
    held.answer(2);
    await turns();
    held.answer(3);

    expect((await Promise.all(all)).map((bytes) => bytes.byteLength)).toEqual(
      Array(4).fill(PDF.length),
    );
  });

  it("the wait for a slot counts toward the fetch timeout: nothing asked, a2a.file-fetch-failed", async () => {
    const held = heldTransport();
    const slots = slotsOf(1, 10);
    const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));

    void fetchedFile(fetchOf(held.transport, slots, "holder")).catch(() => undefined);
    const waiting = settled(fetchedFile(fetchOf(held.transport, slots, "waiter", { clock })));
    await turns();
    await clock.advance(seconds(10));

    expect(await waiting).toMatchObject({ code: "a2a.file-fetch-failed" });
    expect(held.asked).toEqual([`${ORIGIN}/holder`]);
  });

  it("a request that ends while it waits leaves the queue: its place is free again", async () => {
    const held = heldTransport();
    const slots = slotsOf(1, 1);
    const closed = new AbortController();

    void fetchedFile(fetchOf(held.transport, slots, "holder")).catch(() => undefined);
    const leaving = settled(
      fetchedFile(fetchOf(held.transport, slots, "leaver", { signal: closed.signal })),
    );
    await turns();
    closed.abort();
    expect(await leaving).toMatchObject({ code: "a2a.file-fetch-failed" });
    const next = fetchedFile(fetchOf(held.transport, slots, "next"));
    await turns();
    held.answer(0);
    await turns();
    held.answer(1);

    expect((await next).byteLength).toBe(PDF.length);
    expect(held.asked).toEqual([`${ORIGIN}/holder`, `${ORIGIN}/next`]);
  });

  it("past the queue a fetch is refused at once, typed: a2a.file-fetch-busy, nothing asked", async () => {
    const held = heldTransport();
    const slots = slotsOf(1, 2);

    const inside = ["a", "b", "c"].map((name) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name))),
    );
    await turns();
    const refused = await settled(fetchedFile(fetchOf(held.transport, slots, "over")));

    expect(refused).toMatchObject({ code: "a2a.file-fetch-busy" });
    await expect(fetchedFile(fetchOf(held.transport, slots, "over-again"))).rejects.toMatchObject({
      message: "the agent is fetching too many files now",
    });
    expect(held.asked).toEqual([`${ORIGIN}/a`]);
    held.answer(0);
    await turns();
    held.answer(1);
    await turns();
    held.answer(2);
    expect(await Promise.all(inside)).toEqual(["fetched", "fetched", "fetched"]);
  });

  it("a request already ended asks nothing, whether a slot is free or not", async () => {
    const held = heldTransport();
    const slots = slotsOf(1, 1);
    const closed = new AbortController();
    closed.abort();

    const free = await settled(
      fetchedFile(fetchOf(held.transport, slots, "free", { signal: closed.signal })),
    );
    void fetchedFile(fetchOf(held.transport, slots, "holder")).catch(() => undefined);
    await turns();
    const busy = await settled(
      fetchedFile(fetchOf(held.transport, slots, "busy", { signal: closed.signal })),
    );

    expect(free).toMatchObject({ code: "a2a.file-fetch-failed" });
    expect(busy).toMatchObject({ code: "a2a.file-fetch-failed" });
    expect(held.asked).toEqual([`${ORIGIN}/holder`]);
  });

  it("a request that ends after its turn came leaves the others in line where they are", async () => {
    const held = heldTransport();
    const slots = slotsOf(1, 10);
    const second = new AbortController();

    void fetchedFile(fetchOf(held.transport, slots, "first")).catch(() => undefined);
    void fetchedFile(fetchOf(held.transport, slots, "second", { signal: second.signal })).catch(
      () => undefined,
    );
    const third = fetchedFile(fetchOf(held.transport, slots, "third"));
    await turns();
    held.answer(0);
    await turns();
    second.abort();
    await turns();
    held.answer(1);
    await turns();
    held.answer(2);

    expect((await third).byteLength).toBe(PDF.length);
    expect(held.asked).toEqual([`${ORIGIN}/first`, `${ORIGIN}/second`, `${ORIGIN}/third`]);
  });

  it("run: a wait that ends with its signal rejects with the signal's reason and leaves the queue", async () => {
    const slots = slotsOf(1, 1);
    const closed = new AbortController();
    const hold = new Promise<void>(() => undefined);
    const reason = new Error("the request ended");
    const busy = () => new Error("busy");

    void slots.run(new AbortController().signal, () => hold, busy, callerOf(""));
    const waiting = slots.run(closed.signal, () => Promise.resolve("never"), busy, callerOf(""));
    closed.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    const next = new AbortController();
    const queued = slots.run(next.signal, () => Promise.resolve("never"), busy, callerOf(""));
    next.abort(reason);
    // its place was free: it waited (and ended with its signal), it was not refused as busy
    await expect(queued).rejects.toBe(reason);
  });

  it("a tenant's flood takes its share only: over it, refused at once; another tenant still gets a slot", async () => {
    const held = heldTransport();
    const slots = new FileFetchSlots(4, 8, { running: 1, queued: 2 }, WIDE);
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf(tenant) })));

    const flood = ["a1", "a2", "a3"].map((name) => as("acme", name));
    await turns();
    const over = await as("acme", "a4");
    const other = as("globex", "b1");
    await turns();

    expect(over).toMatchObject({ code: "a2a.file-fetch-busy" });
    // acme holds one slot, globex has its own at once although slots are free for nobody else of acme
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`]);
    held.answer(0);
    held.answer(1);
    await turns();
    held.answer(2);
    await turns();
    held.answer(3);
    expect(await Promise.all([...flood, other])).toEqual(Array(4).fill("fetched"));
  });

  it("a waiter whose tenant is at its slots is passed over: the next tenant's fetch takes the freed slot", async () => {
    const held = heldTransport();
    const slots = new FileFetchSlots(2, 8, { running: 1, queued: 8 }, WIDE);
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf(tenant) })));

    const all = [as("acme", "a1"), as("acme", "a2"), as("globex", "b1"), as("globex", "b2")];
    await turns();
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`]);
    held.answer(1);
    await turns();
    // globex's slot is free; acme's a2 is first in line but acme holds its one: b2 takes it
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`, `${ORIGIN}/b2`]);
    held.answer(0);
    await turns();
    held.answer(2);
    await turns();
    held.answer(3);
    expect(await Promise.all(all)).toEqual(Array(4).fill("fetched"));
  });

  it("a freed slot with only capped waiters in line goes to none of them", async () => {
    const held = heldTransport();
    const slots = new FileFetchSlots(2, 8, { running: 1, queued: 8 }, WIDE);
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf(tenant) })));

    const all = [as("acme", "a1"), as("globex", "b1"), as("acme", "a2")];
    await turns();
    held.answer(1);
    await turns();
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`]);
    held.answer(0);
    await turns();
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`, `${ORIGIN}/a2`]);
    held.answer(2);

    expect(await Promise.all(all)).toEqual(Array(3).fill("fetched"));
  });

  it("owners whose ids would join to one text are different owners, each with its own share", async () => {
    const pairs = [
      [callerKeyOf("a/b", "c"), callerKeyOf("a", "b/c")],
      [callerKeyOf("anonymous:x", "o"), callerKeyOf("x", undefined)],
      [callerKeyOf("t", undefined), callerKeyOf("t", "anonymous")],
      [callerKeyOf("t", undefined), callerKeyOf("t", "null")],
      [callerKeyOf("t", undefined), callerKeyOf("t", "")],
      [tenantKeyOf("t"), callerKeyOf("t", undefined)],
      [tenantKeyOf("a/b"), tenantKeyOf("a")],
      [tenantKeyOf("null"), tenantKeyOf("")],
    ] as const;
    for (const [one, other] of pairs) expect(one).not.toBe(other);
    expect(tenantKeyOf("acme")).toBe('["acme"]');
    expect(callerKeyOf("acme", "dana")).toBe('["acme","dana"]');
    const held = heldTransport();
    const slots = new FileFetchSlots(4, 8, WIDE, { running: 1, queued: 0 });
    const as = (caller: FileCaller, name: string) =>
      fetchedFile(fetchOf(held.transport, slots, name, { caller })).catch(() => undefined);

    void as(callerOf("a/b", "c"), "one");
    void as(callerOf("a", "b/c"), "other");
    await turns();

    expect(held.asked).toEqual([`${ORIGIN}/one`, `${ORIGIN}/other`]);
  });

  it("the default shares: a tenant holds a quarter of the slots and four places per slot, an owner two (half its tenant's share at most) and eight places", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(16, undefined);
    const as = (owner: string, name: string) =>
      settled(
        fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf("acme", owner) })),
      );

    // 20 owners of one tenant, one fetch each: the tenant's 4 run, its 16 queue places fill, the next is refused
    const first = Array.from({ length: 4 + 16 }, (_, at) => as(`o${String(at)}`, `f${String(at)}`));
    await turns();
    const over = await as("o99", "over");

    expect(held.asked).toHaveLength(4);
    expect(over).toMatchObject({ code: "a2a.file-fetch-busy" });
    expect(first).toHaveLength(20);
    // one owner: its share is 2 running and 8 queued, in a tenant of 4
    const owned = fileSlotsOf(16, undefined);
    const alone = (name: string) =>
      settled(
        fetchedFile(fetchOf(held.transport, owned, name, { caller: callerOf("globex", "dana") })),
      );
    const dana = Array.from({ length: 2 + 8 }, (_, at) => alone(`d${String(at)}`));
    await turns();
    expect(held.asked).toHaveLength(4 + 2);
    expect(await alone("d-over")).toMatchObject({ code: "a2a.file-fetch-busy" });
    expect(dana).toHaveLength(10);
    const single = fileSlotsOf(1, undefined);
    const only = fetchedFile(
      fetchOf(held.transport, single, "solo", { caller: callerOf("t", "o") }),
    ).catch(() => undefined);
    await turns();
    expect(held.asked.at(-1)).toBe(`${ORIGIN}/solo`);
    void only;
  });

  it("the tenant's share bounds the sum of its owners: 20 owners of one tenant never run more than the tenant's share, queue no more than its share, and another tenant still gets a slot", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(undefined, undefined); // 16 slots, 4 per tenant (queue 16), 1 per owner (queue 4)
    const as = (tenant: string, owner: string, name: string) =>
      settled(
        fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf(tenant, owner) })),
      );

    // 20 owners, 8 fetches each: 160 in all
    const flood = Array.from({ length: 160 }, (_, at) =>
      as("acme", `o${String(at % 20)}`, `a${String(at)}`),
    );
    await turns();
    const other = as("globex", "g", "b1");
    await turns();

    // acme runs 4 (not 16) and queues 16 (not the listener's 64): the other 140 are refused at once
    expect(held.asked.filter((url) => url.includes("/a"))).toHaveLength(4);
    expect(held.asked).toContain(`${ORIGIN}/b1`);
    expect(held.asked).toHaveLength(5);
    const refused = await Promise.all(flood.slice(20));
    expect(refused.filter((outcome) => outcome === "fetched")).toHaveLength(0);
    expect(
      refused.filter((outcome) => (outcome as { code: string }).code === "a2a.file-fetch-busy"),
    ).toHaveLength(140);
    held.answer(held.asked.indexOf(`${ORIGIN}/b1`));
    expect(await other).toBe("fetched");
  });

  it("an owner's flood inside one tenant is bounded by the owner's share: its fetches past it are refused, its tenant's other owners still run", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(undefined, undefined); // tenant 4 (queue 16), owner 2 (queue 8)
    const as = (owner: string, name: string) =>
      settled(
        fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf("acme", owner) })),
      );

    const flood = Array.from({ length: 14 }, (_, at) => as("dana", `d${String(at)}`));
    await turns();
    const refused = await Promise.all(flood.slice(10));
    const eli = as("eli", "e1");
    await turns();

    // dana: 2 run, 8 wait, the other 4 are refused although the tenant has 2 slots and 8 places left
    expect(held.asked).toEqual([`${ORIGIN}/d0`, `${ORIGIN}/d1`, `${ORIGIN}/e1`]);
    for (const outcome of refused) expect(outcome).toMatchObject({ code: "a2a.file-fetch-busy" });
    held.answer(0);
    held.answer(1);
    held.answer(2);
    await turns();
    expect(await eli).toBe("fetched");
  });

  it("an ownerless caller uses its tenant's share directly: no owner's share binds it, and it takes from the tenant's (#1339)", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(16, 4, 2);
    const as = (owner: string | undefined, name: string) =>
      settled(
        fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf("acme", owner) })),
      );

    const anonymous = ["n1", "n2", "n3"].map((name) => as(undefined, name));
    const named = ["x1", "x2", "x3"].map((name) => as("x", name));
    await turns();

    // three ownerless run (no owner's share of 2 holds them), x1 takes the tenant's fourth; x2 and x3 wait
    expect(held.asked).toEqual([`${ORIGIN}/n1`, `${ORIGIN}/n2`, `${ORIGIN}/n3`, `${ORIGIN}/x1`]);
    expect(slots.callers).toBe(1);
    expect(slots.tenants).toBe(1);
    held.answer(0);
    held.answer(1);
    held.answer(2);
    held.answer(3);
    await turns();
    held.answer(4);
    held.answer(5);
    expect(await Promise.all([...anonymous, ...named])).toEqual(Array(6).fill("fetched"));
    expect(slots.callers).toBe(0);
    expect(slots.tenants).toBe(0);
  });

  it("the ownerless fetches of one tenant are never one fake owner's bucket: six of them, the tenant's four run and two wait — none refused, though an owner's share is 2 (#1339)", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(16, undefined); // tenant 4 (queue 16), owner 2 (queue 8)
    const alone = (name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf("acme") })));

    const flood = Array.from({ length: 6 }, (_, at) => alone(`n${String(at)}`));
    await turns();

    expect(held.asked).toHaveLength(4);
    for (let at = 0; at < 6; at += 1) {
      held.answer(at);
      await turns();
    }
    expect(await Promise.all(flood)).toEqual(Array(6).fill("fetched"));
  });

  it("a single owner of two slots in all (fileSlotsOf(2, 10)) holds one: half of its tenant's share, so two owners share it (#1366)", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(2, 10);
    const as = (owner: string, name: string) =>
      settled(
        fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf("acme", owner) })),
      );

    const dana = [as("dana", "d1"), as("dana", "d2")];
    const eli = as("eli", "e1");
    await turns();

    expect(held.asked).toEqual([`${ORIGIN}/d1`, `${ORIGIN}/e1`]);
    held.answer(0);
    held.answer(1);
    await turns();
    held.answer(2);
    expect(await Promise.all([...dana, eli])).toEqual(Array(3).fill("fetched"));
  });

  it("the global bounds hold across callers, each under its own share: slots, a handed-over slot, the queue", async () => {
    const held = heldTransport();
    const slots = slotsOf(2, 2);
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf(tenant) })));

    const results = [as("a", "a1"), as("b", "b1"), as("c", "c1"), as("d", "d1")];
    await turns();
    const refused = await as("e", "e1");
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`]);
    expect(refused).toMatchObject({ code: "a2a.file-fetch-busy" });
    // two run, two only wait: all four are tenants (ownerless callers), the refused one is none
    expect(slots.tenants).toBe(4);

    held.answer(0);
    await turns();
    const afterHandOver = as("f", "f1");
    await turns();
    // c1 took a1's slot: two run (b1, c1), d1 and f1 wait — nobody started beyond the limit
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`, `${ORIGIN}/c1`]);
    held.answer(1);
    await turns();
    held.answer(2);
    await turns();
    held.answer(3);
    await turns();
    held.answer(4);
    expect(await Promise.all([...results, afterHandOver])).toEqual(Array(5).fill("fetched"));
    expect(slots.tenants).toBe(0);
  });

  it("a caller's share of the queue is given back when its waiters start: it can queue again", async () => {
    const held = heldTransport();
    const slots = new FileFetchSlots(1, 10, { running: 1, queued: 2 }, WIDE);
    const as = (name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { caller: callerOf("acme") })));

    const first = [as("a1"), as("a2"), as("a3")];
    await turns();
    held.answer(0);
    await turns();
    held.answer(1);
    await turns();
    const again = [as("a4"), as("a5")];
    await turns();
    const over = await as("a6");

    expect(over).toMatchObject({ code: "a2a.file-fetch-busy" });
    for (const at of [2, 3, 4]) {
      held.answer(at);
      await turns();
    }
    expect(await Promise.all([...first, ...again])).toEqual(Array(5).fill("fetched"));
    expect(slots.callers).toBe(0);
  });

  it("a failed fetch gives its slot back", async () => {
    const slots = slotsOf(1, 0);
    const failing: FileFetch["transport"] = () => Promise.reject(new Error("unreachable"));
    const held = heldTransport();

    for (let round = 0; round < 3; round += 1)
      expect(await settled(fetchedFile(fetchOf(failing, slots, "x")))).toMatchObject({
        code: "a2a.file-fetch-failed",
      });
    const ok = fetchedFile(fetchOf(held.transport, slots, "y"));
    await turns();
    held.answer(0);

    expect((await ok).byteLength).toBe(PDF.length);
  });
});

/** A files application whose workflow's `@FilePolicy` has this `fetchPool` (#1316): its own slots. */
function poolApplication(fetchPool: FileFetchPool) {
  counter += 1;
  const id = String(counter);

  @FilePolicy({
    ttl: hours(24),
    name: `pool-${id}-file-policy`,
    allowedMediaTypes: ["application/pdf", "text/plain", "image/png"],
    allowedOrigins: [FILE_ORIGIN],
    fetchPool,
  })
  class PoolPolicy {}

  @Workflow({
    name: `pool-${id}-file-review-workflow`,
    version: "1.0.0",
    flow: fileReviewFlow,
    filePolicy: PoolPolicy,
  })
  class PoolWorkflow {}

  @Application({
    name: `pool-${id}-files-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [PoolWorkflow],
    providers: [BearerAuthenticator, FileCallerChannel],
    exposes: [FilesA2AExpose],
    budgets: TEST_BUDGETS,
  })
  class PoolApplication {}
  return PoolApplication;
}

let counter = 0;
const poolTest = (fetchPool: FileFetchPool) => testWith(poolApplication(fetchPool));

describe("#1256: over the wire", () => {
  poolTest({ maxConcurrent: 1 })(
    "distinct messages share the policy's pool: maxConcurrent: 1 asks one origin fetch at a time",
    async ({ a2aServer }) => {
      const script = scriptedTransport({ [`${FILE_ORIGIN}/a.pdf`]: { body: PDF } });
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transport: FileTransport = async (url, signal) => {
        const answer = script.transport(url, signal);
        await gate;
        return answer;
      };
      const { url } = await a2aServer(
        withFileTransport(
          { expose: FilesA2AExpose, authenticator: BearerAuthenticator },
          transport,
        ),
      );
      const parts = [urlPart(`${FILE_ORIGIN}/a.pdf`, "application/pdf")];

      const sends = ["m-1", "m-2", "m-3"].map((id) =>
        rpc(url, "SendMessage", fileMessage(id, parts)),
      );
      await until(() => script.asked.length >= 1, "the first fetch started");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(script.asked).toHaveLength(1);
      release();
      const answers = await Promise.all(sends);

      expect(script.asked).toHaveLength(3);
      expect(answers.every((answer) => answer.body.result !== undefined)).toBe(true);
    },
  );
});

describe("#1256: a tenant's share, over the wire", () => {
  poolTest({ maxConcurrent: 8, maxConcurrentPerTenant: 3, maxConcurrentPerOwner: 3 })(
    "maxConcurrentPerTenant: 3 of 8: tenant acme sends five messages, three fetch, globex's still does",
    async ({ a2aServer }) => {
      const script = scriptedTransport({ [`${FILE_ORIGIN}/a.pdf`]: { body: PDF } });
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transport: FileTransport = async (url, signal) => {
        const answer = script.transport(url, signal);
        await gate;
        return answer;
      };
      const { url } = await a2aServer(
        withFileTransport(
          { expose: FilesA2AExpose, authenticator: BearerAuthenticator },
          transport,
        ),
      );
      const parts = [urlPart(`${FILE_ORIGIN}/a.pdf`, "application/pdf")];
      const send = (tenant: string, id: string) =>
        rpc(url, "SendMessage", fileMessage(id, parts), {
          headers: { authorization: `Bearer dana`, "x-tenant": tenant },
        });

      const sends = [
        ...["m-1", "m-2", "m-3", "m-4", "m-5"].map((id) => send("acme", id)),
        send("globex", "g-1"),
      ];
      await until(() => script.asked.length >= 4, "three of acme's and globex's fetches started");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(script.asked).toHaveLength(4);
      release();
      await Promise.all(sends);

      expect(script.asked).toHaveLength(6);
    },
  );
});

describe("#1297: a tenant's share bounds the sum of its owners; an owner's share is inside it", () => {
  const held = async (a2aServer: A2AServerFixture) => {
    const script = scriptedTransport({ [`${FILE_ORIGIN}/a.pdf`]: { body: PDF } });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: FileTransport = async (url, signal) => {
      const answer = script.transport(url, signal);
      await gate;
      return answer;
    };
    const { url } = await a2aServer(
      withFileTransport({ expose: FilesA2AExpose, authenticator: BearerAuthenticator }, transport),
    );
    const parts = [urlPart(`${FILE_ORIGIN}/a.pdf`, "application/pdf")];
    const send = (tenant: string | undefined, owner: string, id: string) =>
      rpc(url, "SendMessage", fileMessage(id, parts), {
        headers: {
          authorization: `Bearer ${owner}`,
          ...(tenant === undefined ? {} : { "x-tenant": tenant }),
        },
      });
    return {
      script,
      release: () => {
        release();
      },
      send,
    };
  };

  poolTest({ maxConcurrent: 8, maxConcurrentPerTenant: 2 })(
    "five owners of acme, a tenant share of 2: two fetch, the others of acme wait, globex's owner still fetches",
    async ({ a2aServer }) => {
      const { script, release, send } = await held(a2aServer);

      const sends = [
        ...["o1", "o2", "o3", "o4", "o5"].map((owner, at) =>
          send("acme", owner, `a-${String(at)}`),
        ),
        send("globex", "g1", "g-1"),
      ];
      await until(() => script.asked.length >= 3, "two of acme's and globex's fetches started");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(script.asked).toHaveLength(3);
      release();
      await Promise.all(sends);

      expect(script.asked).toHaveLength(6);
    },
  );

  poolTest({ maxConcurrent: 8, maxConcurrentPerTenant: 4, maxConcurrentPerOwner: 1 })(
    "one owner of acme, an owner share of 1 in a tenant of 4: dana floods, eli of the same tenant still gets his slot",
    async ({ a2aServer }) => {
      const { script, release, send } = await held(a2aServer);

      const sends = [
        send(undefined, "dana", "d-1"),
        send(undefined, "dana", "d-2"),
        send(undefined, "dana", "d-3"),
        send(undefined, "eli", "e-1"),
      ];
      await until(() => script.asked.length >= 2, "dana's and eli's fetches started");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(script.asked).toHaveLength(2);
      release();
      await Promise.all(sends);

      expect(script.asked).toHaveLength(4);
    },
  );
});

describe("#1316: a fetchPool is checked with its policy", () => {
  const problemsOf = (fetchPool: object) => {
    @FilePolicy({ ttl: hours(24), name: "pool-check-file-policy", fetchPool })
    class Checked {}
    return filePolicyViolations("app", Checked, ["app"]).map((found) => found.message);
  };

  it("0, a fraction, a text: [file-policy.invalid] naming the field", () => {
    for (const field of [
      "maxConcurrent",
      "maxConcurrentPerTenant",
      "maxConcurrentPerOwner",
      "maxQueuedPerOwner",
    ])
      for (const value of [0, -1, 1.5, "8", Number.NaN])
        expect(problemsOf({ [field]: value })).toEqual([
          `app: pool-check-file-policy: fetchPool.${field} is not a whole number from 1`,
        ]);
    expect(problemsOf({ maxConcurrent: 1, maxQueuedPerOwner: 8 })).toEqual([]);
    expect(problemsOf({})).toEqual([]);
  });
});

describe("#1316: a saturated pool is one error on every path", () => {
  it("DEFAULT_MAX_CONCURRENT_PER_OWNER and the owner's queue are the pool's defaults: 2 and 8", () => {
    expect(DEFAULT_MAX_CONCURRENT_PER_OWNER).toBe(2);
    expect(DEFAULT_MAX_QUEUED_PER_OWNER).toBe(8);
  });
});
