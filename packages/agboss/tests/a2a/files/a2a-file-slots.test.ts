/**
 * #1256: the fetches of files by url a listener has in flight at once are bounded across messages —
 * a slot per fetch, a bounded queue for the rest, the wait part of the fetch timeout, the overflow a
 * stable refusal.
 */
import { describe, expect, it } from "vitest";
import { a2aHttpListener } from "../../../src/a2a/a2a-http.js";
import { fetchedFile, type FileFetch } from "../../../src/a2a/files/a2a-file-fetch.js";
import {
  DEFAULT_MAX_CONCURRENT_FILE_FETCHES,
  FileFetchSlots,
  callerKeyOf,
  fileSlotsOf,
} from "../../../src/a2a/files/a2a-file-slots.js";
import type { FileHttpResponse } from "../../../src/a2a/files/a2a-file-transport.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { kilobytes, seconds } from "../../../src/units/index.js";
import { withFileTransport } from "../../../src/a2a/files/a2a-file-seam.js";
import type { FileTransport } from "../../../src/a2a/files/a2a-file-transport.js";
import { testWith } from "../../../src/testing/index.js";
import { until } from "../../helpers/until.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { FILE_ORIGIN, FilesA2AExpose, FilesApplication } from "../fixtures/files.application.js";
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
  new FileFetchSlots(limit, queued, { running: limit, queued });

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

    void slots.run(new AbortController().signal, () => hold, busy, "");
    const waiting = slots.run(closed.signal, () => Promise.resolve("never"), busy, "");
    closed.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    const next = new AbortController();
    const queued = slots.run(next.signal, () => Promise.resolve("never"), busy, "");
    next.abort(reason);
    // its place was free: it waited (and ended with its signal), it was not refused as busy
    await expect(queued).rejects.toBe(reason);
  });

  it("a tenant's flood takes its share only: over it, refused at once; another tenant still gets a slot", async () => {
    const held = heldTransport();
    const slots = new FileFetchSlots(4, 8, { running: 1, queued: 2 });
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { tenant })));

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
    const slots = new FileFetchSlots(2, 8, { running: 1, queued: 8 });
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { tenant })));

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
    const slots = new FileFetchSlots(2, 8, { running: 1, queued: 8 });
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { tenant })));

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

  it("callers whose ids would join to one text are different callers, each with its own share", async () => {
    const pairs = [
      [callerKeyOf("a/b", "c"), callerKeyOf("a", "b/c")],
      [callerKeyOf("anonymous:x", "o"), callerKeyOf("x", undefined)],
      [callerKeyOf("t", undefined), callerKeyOf("t", "anonymous")],
    ] as const;
    for (const [one, other] of pairs) expect(one).not.toBe(other);
    const held = heldTransport();
    const slots = new FileFetchSlots(4, 8, { running: 1, queued: 0 });
    const as = (tenant: string, name: string) =>
      fetchedFile(fetchOf(held.transport, slots, name, { tenant })).catch(() => undefined);

    void as(callerKeyOf("a/b", "c"), "one");
    void as(callerKeyOf("a", "b/c"), "other");
    await turns();

    expect(held.asked).toEqual([`${ORIGIN}/one`, `${ORIGIN}/other`]);
  });

  it("the default share of a tenant is a quarter of the slots (at least one) and of the queue", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(16, undefined);
    const as = (name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { tenant: "acme" })));

    const first = Array.from({ length: 4 + 16 }, (_, at) => as(`f${String(at)}`));
    await turns();
    const over = await as("over");

    expect(held.asked).toHaveLength(4);
    expect(over).toMatchObject({ code: "a2a.file-fetch-busy" });
    expect(first).toHaveLength(20);
    const single = fileSlotsOf(1, undefined);
    const only = fetchedFile(fetchOf(held.transport, single, "solo", { tenant: "t" })).catch(
      () => undefined,
    );
    await turns();
    expect(held.asked.at(-1)).toBe(`${ORIGIN}/solo`);
    void only;
  });

  it("the global bounds hold across callers, each under its own share: slots, a handed-over slot, the queue", async () => {
    const held = heldTransport();
    const slots = slotsOf(2, 2);
    const as = (tenant: string, name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { tenant })));

    const results = [as("a", "a1"), as("b", "b1"), as("c", "c1"), as("d", "d1")];
    await turns();
    const refused = await as("e", "e1");
    expect(held.asked).toEqual([`${ORIGIN}/a1`, `${ORIGIN}/b1`]);
    expect(refused).toMatchObject({ code: "a2a.file-fetch-busy" });
    // two run, two only wait: all four are callers, the refused one is none
    expect(slots.callers).toBe(4);

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
    expect(slots.callers).toBe(0);
  });

  it("a caller's share of the queue is given back when its waiters start: it can queue again", async () => {
    const held = heldTransport();
    const slots = new FileFetchSlots(1, 10, { running: 1, queued: 2 });
    const as = (name: string) =>
      settled(fetchedFile(fetchOf(held.transport, slots, name, { tenant: "acme" })));

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

const test = testWith(FilesApplication);

describe("#1256: over the wire", () => {
  test("distinct messages share the listener's slots: maxConcurrentFileFetches: 1 asks one origin fetch at a time", async ({
    a2aServer,
  }) => {
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
        {
          expose: FilesA2AExpose,
          callerResolver: BearerCallerResolver,
          maxConcurrentFileFetches: 1,
        },
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
  });
});

describe("#1256: a tenant's share, over the wire", () => {
  test("maxConcurrentFileFetchesPerTenant: 3 of 8: tenant acme sends five messages, three fetch, globex's still does", async ({
    a2aServer,
  }) => {
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
        {
          expose: FilesA2AExpose,
          callerResolver: BearerCallerResolver,
          maxConcurrentFileFetches: 8,
          maxConcurrentFileFetchesPerTenant: 3,
        },
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
  });
});

describe("#1256: a caller's share is its owner's, not its tenant's", () => {
  test("two owners of the default tenant: dana floods, eli still gets his slot", async ({
    a2aServer,
  }) => {
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
        {
          expose: FilesA2AExpose,
          callerResolver: BearerCallerResolver,
          maxConcurrentFileFetches: 8,
          maxConcurrentFileFetchesPerTenant: 1,
        },
        transport,
      ),
    );
    const parts = [urlPart(`${FILE_ORIGIN}/a.pdf`, "application/pdf")];
    const send = (owner: string, id: string) =>
      rpc(url, "SendMessage", fileMessage(id, parts), {
        headers: { authorization: `Bearer ${owner}` },
      });

    const sends = [
      send("dana", "d-1"),
      send("dana", "d-2"),
      send("dana", "d-3"),
      send("eli", "e-1"),
    ];
    await until(() => script.asked.length >= 2, "dana's and eli's fetches started");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(script.asked).toHaveLength(2);
    release();
    await Promise.all(sends);

    expect(script.asked).toHaveLength(4);
  });
});

describe("#1256: maxConcurrentFileFetches is checked when the listener is made", () => {
  const listener =
    (value: unknown, perTenant?: unknown): (() => unknown) =>
    () =>
      a2aHttpListener(
        {} as never,
        {
          expose: {},
          callerResolver: {},
          publicUrl: "https://x.test",
          maxConcurrentFileFetches: value,
          maxConcurrentFileFetchesPerTenant: perTenant,
        } as never,
      );

  it("0, a fraction, a text: [a2a.file-fetch-limit-invalid]", () => {
    for (const value of [0, -1, 1.5, "8", Number.NaN])
      expect(listener(value)).toThrow(
        /\[a2a.file-fetch-limit-invalid\].*maxConcurrentFileFetches/u,
      );
    for (const value of [0, 2.5, "3"])
      expect(listener(undefined, value)).toThrow(
        /\[a2a.file-fetch-limit-invalid\].*maxConcurrentFileFetchesPerTenant/u,
      );
  });
});
