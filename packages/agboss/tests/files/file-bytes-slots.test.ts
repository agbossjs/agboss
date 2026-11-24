/**
 * #1312: a model's read of a file by url takes a fetch slot like an A2A listener's does, under the
 * same tenant and owner keys (#1256, #1297): the cap holds under concurrency, a read over it fails
 * as `a2a.file-fetch-busy` (here as the download's failure, the busy refusal its cause), and the
 * slot goes back when the read ends — whole, refused, failed, cancelled or aborted.
 */
import { describe, expect, it } from "vitest";
import { callerKeyOf, fileSlotsOf, tenantKeyOf } from "../../src/a2a/files/a2a-file-slots.js";
import type { FileFetchSlots } from "../../src/a2a/files/a2a-file-slots.js";
import type { FileHttpResponse, FileTransport } from "../../src/a2a/files/a2a-file-transport.js";
import { fileContentOf, sha256Of, type FileReadContext } from "../../src/files/file-bytes.js";
import {
  ModelFileUnavailableError,
  ModelFileUnavailableReason,
} from "../../src/files/file-errors.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, seconds } from "../../src/units/index.js";
import { until } from "../helpers/until.js";
import { PDF } from "../a2a/files/support.js";

const ORIGIN = "https://files.example";

/** A transport whose fetches wait for the test: how many are open, the most that were, each one's answer. */
function heldTransport(status = 200) {
  const state = { open: 0, most: 0, asked: [] as string[] };
  const answers = new Map<string, (answer: "body" | "fail") => void>();
  const transport: FileTransport = (url, signal) => {
    state.asked.push(url.pathname);
    state.open += 1;
    state.most = Math.max(state.most, state.open);
    return new Promise<FileHttpResponse>((resolve, reject) => {
      const close = (): void => {
        state.open -= 1;
      };
      signal.addEventListener("abort", () => {
        close();
        reject(new Error("aborted"));
      });
      answers.set(url.pathname, (answer) => {
        close();
        if (answer === "fail") reject(new Error("reset"));
        else
          resolve({
            status,
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
  return {
    transport,
    state,
    answer: (path: string, how: "body" | "fail" = "body") => answers.get(path)?.(how),
  };
}

const file = (path: string) => ({
  mediaType: "application/pdf",
  sha256: sha256Of(PDF),
  sizeBytes: PDF.byteLength,
  url: `${ORIGIN}${path}`,
});

const contextOf = (
  transport: FileTransport,
  slots: FileFetchSlots,
  parts: Partial<FileReadContext> = {},
): FileReadContext => ({
  store: new InMemoryA2AFileRepository(new InMemoryDatabase()),
  tenantId: "acme",
  ownerId: "root-1",
  signal: new AbortController().signal,
  clock: new VirtualClock(),
  transport,
  allowedOrigins: [ORIGIN],
  fetchTimeout: seconds(5),
  maxFileSize: kilobytes(1),
  slots,
  caller: { tenant: tenantKeyOf("acme"), owner: callerKeyOf("acme", "u1") },
  ...parts,
});

const outcomeOf = (work: Promise<unknown>) =>
  work.then(
    () => "read" as const,
    (error: unknown) => error,
  );

describe("#1312 a model's read of a file by url takes a fetch slot", () => {
  it("F1 the cap holds under concurrency: 10 reads, at most 2 open at once, all of them read in the end", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(2, 2, 2);
    const paths = Array.from({ length: 10 }, (_, at) => `/f${String(at)}`);
    const reads = paths.map((path) =>
      outcomeOf(fileContentOf(file(path), contextOf(held.transport, slots))),
    );

    for (const path of paths) {
      await until(() => held.state.asked.includes(path), `${path} asked`);
      expect(held.state.open).toBeLessThanOrEqual(2);
      held.answer(path);
    }

    expect(await Promise.all(reads)).toEqual(paths.map(() => "read"));
    expect(held.state.most).toBe(2);
    expect(slots.callers).toBe(0);
    expect(slots.tenants).toBe(0);
  });

  it("F2 over the slots and the queue a read fails at once, the busy refusal its cause; a queued one still runs", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(1, 1, 1); // 1 runs, 4 wait
    const reads = Array.from({ length: 5 }, (_, at) =>
      outcomeOf(fileContentOf(file(`/q${String(at)}`), contextOf(held.transport, slots))),
    );
    await until(() => held.state.asked.length === 1, "the first fetch");

    const over = await outcomeOf(fileContentOf(file("/over"), contextOf(held.transport, slots)));

    expect(over).toBeInstanceOf(ModelFileUnavailableError);
    expect(over).toMatchObject({
      reason: ModelFileUnavailableReason.DownloadFailed,
      cause: { metadata: { code: "a2a.file-fetch-busy" } },
    });
    expect(held.state.asked).not.toContain("/over");
    for (let at = 0; at < 5; at += 1) {
      await until(() => held.state.asked.includes(`/q${String(at)}`), `q${String(at)} asked`);
      held.answer(`/q${String(at)}`);
    }
    expect(await Promise.all(reads)).toEqual(["read", "read", "read", "read", "read"]);
  });

  it("F3 the keys are the listener's: one tenant at its share leaves the others their slots", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(4, 1, 1);
    const acme = (path: string) =>
      contextOf(held.transport, slots, {
        caller: { tenant: tenantKeyOf("acme"), owner: callerKeyOf("acme", path) },
      });
    const first = outcomeOf(fileContentOf(file("/a1"), acme("u1")));
    const second = outcomeOf(fileContentOf(file("/a2"), acme("u2")));
    await until(() => held.state.asked.includes("/a1"), "a1");
    const other = outcomeOf(
      fileContentOf(
        file("/b1"),
        contextOf(held.transport, slots, {
          caller: { tenant: tenantKeyOf("beta"), owner: callerKeyOf("beta", "u1") },
        }),
      ),
    );
    await until(() => held.state.asked.includes("/b1"), "b1");

    expect(held.state.asked).toEqual(["/a1", "/b1"]); // acme's second waits for acme's first

    held.answer("/a1");
    await until(() => held.state.asked.includes("/a2"), "a2");
    held.answer("/a2");
    held.answer("/b1");
    expect(await Promise.all([first, second, other])).toEqual(["read", "read", "read"]);
  });

  it("F4 the slot is back after a failed fetch, a refused status and a too-large body", async () => {
    const slots = fileSlotsOf(1, 1, 1);
    const failing = heldTransport();
    const failed = outcomeOf(fileContentOf(file("/x"), contextOf(failing.transport, slots)));
    await until(() => failing.state.asked.length === 1, "asked");
    failing.answer("/x", "fail");
    expect(await failed).toBeInstanceOf(ModelFileUnavailableError);
    expect(slots.callers).toBe(0);

    const partial = heldTransport(206);
    const refused = outcomeOf(fileContentOf(file("/y"), contextOf(partial.transport, slots)));
    await until(() => partial.state.asked.length === 1, "asked");
    partial.answer("/y");
    expect(await refused).toBeInstanceOf(ModelFileUnavailableError);
    expect(slots.callers).toBe(0);

    const large = heldTransport();
    const tooLarge = outcomeOf(
      fileContentOf(
        file("/z"),
        contextOf(large.transport, slots, { maxFileSize: kilobytes(0.001) }),
      ),
    );
    await until(() => large.state.asked.length === 1, "asked");
    large.answer("/z");
    expect(await tooLarge).toMatchObject({ refusal: "too-large" });
    expect(slots.callers).toBe(0);

    const ok = heldTransport();
    const read = outcomeOf(fileContentOf(file("/ok"), contextOf(ok.transport, slots)));
    await until(() => ok.state.asked.length === 1, "the slot was free again");
    ok.answer("/ok");
    expect(await read).toBe("read");
  });

  it("F5 the slot is back after an abort, running or queued", async () => {
    const held = heldTransport();
    const slots = fileSlotsOf(1, 1, 1);
    const running = new AbortController();
    const queued = new AbortController();
    const first = outcomeOf(
      fileContentOf(file("/r"), contextOf(held.transport, slots, { signal: running.signal })),
    );
    await until(() => held.state.asked.length === 1, "running");
    const second = outcomeOf(
      fileContentOf(file("/w"), contextOf(held.transport, slots, { signal: queued.signal })),
    );

    queued.abort();
    expect(await second).toBeInstanceOf(ModelFileUnavailableError);
    expect(held.state.asked).toEqual(["/r"]); // the queued one never fetched

    running.abort();
    expect(await first).toBeInstanceOf(ModelFileUnavailableError);
    expect(slots.callers).toBe(0);
    expect(slots.tenants).toBe(0);

    const next = outcomeOf(fileContentOf(file("/n"), contextOf(held.transport, slots)));
    await until(() => held.state.asked.includes("/n"), "the slot was free again");
    held.answer("/n");
    expect(await next).toBe("read");
  });

  it("F6 a read with no slots in its context is unbounded, as before", async () => {
    const held = heldTransport();
    const reads = ["/u1", "/u2", "/u3"].map((path) =>
      outcomeOf(
        fileContentOf(file(path), {
          ...contextOf(held.transport, fileSlotsOf(1, 1, 1)),
          slots: undefined,
        }),
      ),
    );
    await until(() => held.state.asked.length === 3, "all three at once");
    for (const path of ["/u1", "/u2", "/u3"]) held.answer(path);
    expect(await Promise.all(reads)).toEqual(["read", "read", "read"]);
  });
});
