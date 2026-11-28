/**
 * #1356 (shard `a2a-files`): what `Files` takes from a workflow's file limits — the ttl a saved file keeps (its own,
 * never above the policy's, none for ever), the digest a file by url may lack, and the share of the pool a read by url
 * counts against: the caller's tenant and owner, so one tenant's second read waits for its first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Files } from "../../../../src/a2a/files/files.service.js";
import { ComponentOptions } from "../../../../src/components/component-options.js";
import { FileError } from "../../../../src/core/error-families/remote-errors.js";
import { FileRefusal } from "../../../../src/files/file-errors.js";
import { fileLimitsOf, type FileLimits } from "../../../../src/files/file-policy.js";
import { InMemoryDatabase } from "../../../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../../../src/infrastructure/in-memory-file.repository.js";
import { VirtualClock } from "../../../../src/testing/clock.js";
import { hours, Ttl } from "../../../../src/units/index.js";
import { inTestFrame } from "../../../helpers/frame.js";
import type { FileHttpResponse } from "../../../../src/a2a/files/a2a-file-transport.js";

const transport = vi.hoisted(() => ({
  responder: undefined as undefined | ((url: URL, signal: AbortSignal) => Promise<unknown>),
}));
vi.mock("../../../../src/a2a/files/a2a-file-transport.js", async (original) => ({
  ...(await original<typeof import("../../../../src/a2a/files/a2a-file-transport.js")>()),
  httpsFileTransport: (url: URL, signal: AbortSignal) => {
    if (transport.responder === undefined) throw new Error("no responder");
    return transport.responder(url, signal);
  },
}));

const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
const base = fileLimitsOf(undefined);
const withLimits = (limits: Partial<FileLimits>) =>
  vi.spyOn(ComponentOptions.none, "workflowFileLimits").mockReturnValue({ ...base, ...limits });
const PDF = new TextEncoder().encode("%PDF-1.4 a pdf");

afterEach(() => {
  vi.restoreAllMocks();
  transport.responder = undefined;
});

/** What a store was asked to keep of the file a step saved. */
async function savedWith(own: number | undefined, limits: Partial<FileLimits>) {
  withLimits(limits);
  const store = new InMemoryFileRepository(new InMemoryDatabase());
  const save = vi.spyOn(store, "save");
  await inTestFrame(() =>
    new Files(store, clock, ComponentOptions.none).save({
      bytes: PDF,
      mediaType: "application/pdf",
      ...(own === undefined ? {} : { ttl: own as never }),
    }),
  );
  return save.mock.calls[0]?.[0];
}

describe("#1356: the ttl of a saved file", () => {
  it("is its own when it has one, up to the policy's, and the policy's when it has none", async () => {
    expect((await savedWith(hours(1), { ttl: hours(2) }))?.ttl).toBe(hours(1));
    expect((await savedWith(hours(2), { ttl: hours(2) }))?.ttl).toBe(hours(2));
    expect((await savedWith(1, { ttl: hours(2) }))?.ttl).toBe(1);
    expect((await savedWith(undefined, { ttl: hours(2) }))?.ttl).toBe(hours(2));
  });

  it("is none for ever: a policy of Ttl.Forever and no ttl of its own keeps no ttl at all", async () => {
    const saved = await savedWith(undefined, { ttl: Ttl.Forever });

    expect(saved).toBeDefined();
    expect(saved).not.toHaveProperty("ttl");
    expect((await savedWith(hours(5), { ttl: Ttl.Forever }))?.ttl).toBe(hours(5));
  });

  it.each([
    ["zero", 0],
    ["below zero", -1],
    ["a fraction", 1.5],
    ["not a number", Number.NaN],
    ["above the policy's", hours(2) + 1],
  ])("is refused when it is %s", async (_why, own) => {
    withLimits({ ttl: hours(2) });
    const store = new InMemoryFileRepository(new InMemoryDatabase());

    const refusal = await inTestFrame(() =>
      new Files(store, clock, ComponentOptions.none)
        .save({ bytes: PDF, mediaType: "application/pdf", ttl: own as never })
        .catch((error: unknown) => error),
    );

    expect(refusal).toBeInstanceOf(FileError.Refused);
    expect((refusal as FileError.Refused).refusal).toBe(FileRefusal.TtlAbovePolicy);
  });
});

/** A transport whose every response is `bytes`, held until `release`, counting the fetches in flight. */
function heldTransport(bytes: Uint8Array) {
  const state = { running: 0, peak: 0, release: (): void => undefined };
  let opened: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    opened = resolve;
  });
  state.release = opened;
  transport.responder = async () => {
    state.running += 1;
    state.peak = Math.max(state.peak, state.running);
    await gate;
    state.running -= 1;
    const response: FileHttpResponse = {
      status: 200,
      location: undefined,
      body: (async function* () {
        await Promise.resolve();
        yield bytes;
      })(),
      cancel: () => undefined,
    };
    return response;
  };
  return state;
}

describe("#1356: a file by url read through the pool", () => {
  const URL_FILE = { mediaType: "application/pdf", url: "https://f.example/a.pdf" };
  const origins = { allowedOrigins: ["https://f.example"] };

  it("may come without a digest: the origin owns its bytes", async () => {
    withLimits(origins);
    const state = heldTransport(PDF);
    state.release();

    const bytes = await inTestFrame(() =>
      new Files(
        new InMemoryFileRepository(new InMemoryDatabase()),
        clock,
        ComponentOptions.none,
      ).read(URL_FILE),
    );

    expect(Buffer.from(bytes).toString()).toBe("%PDF-1.4 a pdf");
  });

  it("is refused when its digest is not the bytes'", async () => {
    withLimits(origins);
    heldTransport(PDF).release();

    const refusal = await inTestFrame(() =>
      new Files(new InMemoryFileRepository(new InMemoryDatabase()), clock, ComponentOptions.none)
        .read({ ...URL_FILE, sha256: "a".repeat(64) })
        .catch((error: unknown) => error),
    );

    expect(refusal).toMatchObject({ reason: "digest-mismatch" });
  });

  it("counts against the caller's tenant: a tenant's second read waits for its first", async () => {
    withLimits({
      ...origins,
      fetchPool: {
        maxConcurrent: 4,
        maxConcurrentPerTenant: 1,
        maxConcurrentPerOwner: 1,
        maxQueuedPerOwner: 4,
      },
    });
    const state = heldTransport(PDF);
    const files = new Files(
      new InMemoryFileRepository(new InMemoryDatabase()),
      clock,
      ComponentOptions.none,
    );

    const both = inTestFrame(() => Promise.all([files.read(URL_FILE), files.read(URL_FILE)]));
    await vi.waitFor(() => {
      expect(state.peak).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const peakWhileHeld = state.peak;
    state.release();
    await both.catch(() => undefined);

    expect(peakWhileHeld).toBe(1);
  });
});
