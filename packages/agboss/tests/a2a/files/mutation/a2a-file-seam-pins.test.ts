/**
 * #1244: the listener options' seams (a test's file transport, its fetches in flight), and the
 * fetches' joins and leaves: who shares a fetch, when it is aborted, what a late settle leaves alone.
 */
import { describe, expect, it, vi } from "vitest";
import { FileFetches, type FileFetchKey } from "../../../../src/a2a/files/a2a-file-fetches.js";
import {
  fileFetchesOf,
  fileTransportOf,
  withFileFetches,
  withFileTransport,
} from "../../../../src/a2a/files/a2a-file-seam.js";
import type { FileTransport } from "../../../../src/a2a/files/a2a-file-transport.js";

const transport: FileTransport = () => Promise.reject(new Error("no network in this test"));

describe("the transport seam", () => {
  it("the options carry the transport, and are copied with it", () => {
    const options = { a: 1 };

    const carrying = withFileTransport(options, transport);

    expect(fileTransportOf(carrying)).toBe(transport);
    expect(carrying).toMatchObject({ a: 1 });
    expect(fileTransportOf(options)).toBeUndefined();
    expect(fileTransportOf({})).toBeUndefined();
  });

  it("only a function is a transport", () => {
    const [symbol] = Object.getOwnPropertySymbols(withFileTransport({}, transport));
    if (symbol === undefined) throw new Error("no symbol");
    const options = {};
    Reflect.set(options, symbol, { not: "a function" });

    expect(fileTransportOf(options)).toBeUndefined();
  });
});

describe("the fetches seam", () => {
  it("the options carry the fetches; else a new set each time", () => {
    const fetches = new FileFetches();
    const carrying = withFileFetches({ a: 1 }, fetches);

    expect(fileFetchesOf(carrying)).toBe(fetches);
    expect(carrying).toMatchObject({ a: 1 });
    expect(fileFetchesOf({})).toBeInstanceOf(FileFetches);
    expect(fileFetchesOf({})).not.toBe(fileFetchesOf({}));
  });

  it("only a FileFetches is taken", () => {
    const [symbol] = Object.getOwnPropertySymbols(withFileFetches({}, new FileFetches()));
    if (symbol === undefined) throw new Error("no symbol");
    const options = {};
    Reflect.set(options, symbol, { waiting: 0 });

    expect(fileFetchesOf(options)).toBeInstanceOf(FileFetches);
    expect(fileFetchesOf(options)).not.toBe(Reflect.get(options, symbol));
  });
});

const KEY: FileFetchKey = {
  tenantId: "t",
  ownerId: "o",
  messageId: "m",
  skill: "s",
  index: 0,
  url: "https://f.example/a",
};
const BYTES = Uint8Array.from([1, 2, 3]);
const left = () => new Error("left");

interface Deferred {
  readonly promise: Promise<Uint8Array>;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
}
function deferred(): Deferred {
  let resolve: (bytes: Uint8Array) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Uint8Array>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A fetch function that records its calls, each with a deferred result. */
function recorder() {
  const calls: { signal: AbortSignal; result: Deferred }[] = [];
  const fetch = (signal: AbortSignal): Promise<Uint8Array> => {
    const result = deferred();
    calls.push({ signal, result });
    return result.promise;
  };
  return { calls, fetch };
}

describe("FileFetches", () => {
  it("the same key joins the fetch in flight; another key fetches on its own", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const a = new AbortController();
    const b = new AbortController();

    const first = fetches.bytesOf(KEY, a.signal, fetch, left);
    const second = fetches.bytesOf(KEY, b.signal, fetch, left);
    const other = fetches.bytesOf({ ...KEY, index: 1 }, b.signal, fetch, left);
    expect(calls).toHaveLength(2);
    expect(fetches.waiting).toBe(3);
    calls[0]?.result.resolve(BYTES);
    calls[1]?.result.resolve(Uint8Array.from([9]));

    expect(await first).toBe(BYTES);
    expect(await second).toBe(BYTES);
    expect([...(await other)]).toEqual([9]);
    expect(fetches.waiting).toBe(0);
  });

  it("every part of the key tells fetches apart; an undefined owner is its own", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const { signal } = new AbortController();
    const keys: FileFetchKey[] = [
      KEY,
      { ...KEY, tenantId: "t2" },
      { ...KEY, ownerId: "o2" },
      { ...KEY, ownerId: undefined },
      { ...KEY, messageId: "m2" },
      { ...KEY, skill: "s2" },
      { ...KEY, index: 2 },
      { ...KEY, url: "https://f.example/b" },
    ];

    for (const key of keys) void fetches.bytesOf(key, signal, fetch, left).catch(() => undefined);

    expect(calls).toHaveLength(keys.length);
  });

  it("a settled fetch leaves nothing: the next request fetches again", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const { signal } = new AbortController();

    const first = fetches.bytesOf(KEY, signal, fetch, left);
    calls[0]?.result.resolve(BYTES);
    await first;
    const second = fetches.bytesOf(KEY, signal, fetch, left);
    calls[1]?.result.reject(new Error("failed"));

    await expect(second).rejects.toThrow("failed");
    expect(calls).toHaveLength(2);
    const third = fetches.bytesOf(KEY, signal, fetch, left);
    expect(calls).toHaveLength(3);
    calls[2]?.result.resolve(BYTES);
    await third;
  });

  it("a failure that is no Error is wrapped in one", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();

    const waiting = fetches.bytesOf(KEY, new AbortController().signal, fetch, left);
    calls[0]?.result.reject("plain text");

    await expect(waiting).rejects.toThrow(new Error("plain text"));
  });

  it("the last request to leave aborts the fetch; the others' leaving does not", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const a = new AbortController();
    const b = new AbortController();
    const whenLeft = vi.fn(left);

    const first = fetches.bytesOf(KEY, a.signal, fetch, whenLeft);
    const second = fetches.bytesOf(KEY, b.signal, fetch, whenLeft);
    a.abort();
    await expect(first).rejects.toThrow("left");
    expect(calls[0]?.signal.aborted).toBe(false);
    expect(fetches.waiting).toBe(1);
    b.abort();
    await expect(second).rejects.toThrow("left");

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(whenLeft).toHaveBeenCalledTimes(2);
    expect(fetches.waiting).toBe(0);
  });

  it("a request already ended when it asks leaves at once: refused, the fetch aborted", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const ended = new AbortController();
    ended.abort();
    const whenLeft = vi.fn(left);

    await expect(fetches.bytesOf(KEY, ended.signal, fetch, whenLeft)).rejects.toThrow("left");

    expect(whenLeft).toHaveBeenCalledTimes(1);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(fetches.waiting).toBe(0);
  });

  it("an already ended request among others leaves the others' fetch running", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const ended = new AbortController();
    ended.abort();

    const live = fetches.bytesOf(KEY, new AbortController().signal, fetch, left);
    await expect(fetches.bytesOf(KEY, ended.signal, fetch, left)).rejects.toThrow("left");
    expect(calls[0]?.signal.aborted).toBe(false);
    calls[0]?.result.resolve(BYTES);

    expect(await live).toBe(BYTES);
  });

  it("a request's abort is heard once: a second abort event is no second leave", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const a = new AbortController();
    const b = new AbortController();
    const whenLeft = vi.fn(left);

    const first = fetches.bytesOf(KEY, a.signal, fetch, whenLeft);
    void fetches.bytesOf(KEY, b.signal, fetch, whenLeft).catch(() => undefined);
    a.abort();
    a.signal.dispatchEvent(new Event("abort"));
    await expect(first).rejects.toThrow("left");

    expect(fetches.waiting).toBe(1);
    expect(whenLeft).toHaveBeenCalledTimes(1);
    expect(calls[0]?.signal.aborted).toBe(false);
  });

  it("a request that got its bytes (or its failure) no longer hears its signal", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const done = new AbortController();
    const failed = new AbortController();
    const whenLeft = vi.fn(left);

    const bytes = fetches.bytesOf(KEY, done.signal, fetch, whenLeft);
    calls[0]?.result.resolve(BYTES);
    await bytes;
    const failure = fetches.bytesOf({ ...KEY, index: 1 }, failed.signal, fetch, whenLeft);
    calls[1]?.result.reject(new Error("x"));
    await expect(failure).rejects.toThrow("x");
    done.abort();
    failed.abort();

    expect(whenLeft).not.toHaveBeenCalled();
  });

  it("a fetch abandoned and started again: the first's late end does not forget the second", async () => {
    const fetches = new FileFetches();
    const { calls, fetch } = recorder();
    const a = new AbortController();

    const abandoned = fetches.bytesOf(KEY, a.signal, fetch, left);
    a.abort();
    await expect(abandoned).rejects.toThrow("left");
    const second = fetches.bytesOf(KEY, new AbortController().signal, fetch, left);
    calls[0]?.result.resolve(BYTES);
    await Promise.resolve();
    const third = fetches.bytesOf(KEY, new AbortController().signal, fetch, left);

    expect(calls).toHaveLength(2);
    expect(fetches.waiting).toBe(2);
    calls[1]?.result.resolve(Uint8Array.from([7]));
    expect([...(await second)]).toEqual([7]);
    expect([...(await third)]).toEqual([7]);
  });
});
