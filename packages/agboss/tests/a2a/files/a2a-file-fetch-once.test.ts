/**
 * #904 item 6: concurrent duplicates of one message fetch its file by url once on a listener — the
 * duplicates join the fetch in flight (`FileFetches`); a request that ends leaves it, the last one
 * to leave aborts it; nothing is kept once it settles.
 */
import { describe, expect, it } from "vitest";
import { FileFetches, type FileFetchKey } from "../../../src/a2a/files/a2a-file-fetches.js";
import { withFileFetches, withFileTransport } from "../../../src/a2a/files/a2a-file-seam.js";
import type { FileTransport } from "../../../src/a2a/files/a2a-file-transport.js";
import { testWith } from "../../../src/testing/index.js";
import { until } from "../../helpers/until.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { FILE_ORIGIN, FilesA2AExpose, FilesApplication } from "../fixtures/files.application.js";
import { rpc } from "../server/rpc.js";
import { fileMessage, PDF, scriptedTransport, urlPart } from "./support.js";

const KEY: FileFetchKey = {
  tenantId: "acme",
  ownerId: "dana",
  messageId: "m-1",
  skill: "file-review-workflow-start",
  index: 0,
  url: `${FILE_ORIGIN}/a.pdf`,
};

/** A fetch the test settles by hand, counting its starts and seeing its signal. */
function heldFetch() {
  const signals: AbortSignal[] = [];
  let settle: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | undefined;
  const fetch = (signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<Uint8Array>((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  return { fetch, signals, settle: () => settle };
}

const left = () => new Error("left");
const live = () => new AbortController().signal;

describe("#904 item 6: FileFetches", () => {
  it("AC6.1 duplicates join the fetch in flight: one fetch, the same bytes; settled, the next fetches again", async () => {
    const held = heldFetch();
    const fetches = new FileFetches();

    const joined = [1, 2, 3].map(() => fetches.bytesOf(KEY, live(), held.fetch, left));
    held.settle()?.resolve(PDF);
    const bytes = await Promise.all(joined);
    void fetches.bytesOf(KEY, live(), held.fetch, left);

    expect(bytes).toEqual([PDF, PDF, PDF]);
    expect(held.signals).toHaveLength(2);
  });

  it("AC6.2 another tenant, owner, message, place or url is a fetch of its own", () => {
    const held = heldFetch();
    const fetches = new FileFetches();
    const others: FileFetchKey[] = [
      { ...KEY, tenantId: "globex" },
      { ...KEY, ownerId: undefined },
      { ...KEY, messageId: "m-2" },
      { ...KEY, index: 1 },
      { ...KEY, url: `${FILE_ORIGIN}/b.pdf` },
    ];

    for (const key of [KEY, ...others]) void fetches.bytesOf(key, live(), held.fetch, left);

    expect(held.signals).toHaveLength(6);
  });

  it("AC6.3 a request that ends leaves; the fetch goes on for the others, its failure is theirs", async () => {
    const held = heldFetch();
    const fetches = new FileFetches();
    const gone = new AbortController();

    const leaving = fetches.bytesOf(KEY, gone.signal, held.fetch, left);
    const staying = fetches.bytesOf(KEY, live(), held.fetch, left);
    gone.abort();
    await expect(leaving).rejects.toThrow("left");
    held.settle()?.reject(new Error("a2a.file-fetch-failed"));

    await expect(staying).rejects.toThrow("a2a.file-fetch-failed");
    expect(held.signals[0]?.aborted).toBe(false);
  });

  it("AC6.4 the last request to leave aborts the fetch and forgets it: a later one fetches anew", async () => {
    const held = heldFetch();
    const fetches = new FileFetches();
    const first = new AbortController();
    const second = new AbortController();

    const both = [first, second].map((each) => fetches.bytesOf(KEY, each.signal, held.fetch, left));
    first.abort();
    second.abort();
    await Promise.allSettled(both);
    void fetches.bytesOf(KEY, live(), held.fetch, left);

    expect(held.signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(fetches.waiting).toBe(1);
  });
});

const test = testWith(FilesApplication);
const listener = { expose: FilesA2AExpose, callerResolver: BearerCallerResolver };

/** A transport whose answers wait for `release()`. */
function gatedTransport() {
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
  return {
    transport,
    asked: script.asked,
    release: () => {
      release();
    },
  };
}

describe("#904 item 6: over the wire", () => {
  test("AC6.5 ten concurrent identical sends of a file by url: one fetch, one task", async ({
    a2aServer,
  }) => {
    const gated = gatedTransport();
    const fetches = new FileFetches();
    const options = withFileFetches(withFileTransport(listener, gated.transport), fetches);
    const { url } = await a2aServer(options);
    const message = fileMessage("dup-1", [urlPart(`${FILE_ORIGIN}/a.pdf`, "application/pdf")]);

    const sends = Array.from({ length: 10 }, () => rpc(url, "SendMessage", message));
    await until(() => fetches.waiting === 10, "ten sends waiting for one fetch");
    gated.release();
    const answers = await Promise.all(sends);

    const ids = answers.map((answer) => (answer.body.result as { task?: { id: string } }).task?.id);
    expect(gated.asked).toEqual([`${FILE_ORIGIN}/a.pdf`]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toEqual(expect.any(String));
  });
});
