/**
 * #1316: a standalone client's `downloadFile` honours a configured `@FilePolicy` — its `maxFileSize`
 * (fail closed, the read stops past it), its `fetchTimeout`, its `fetchPool` — and always runs in the
 * client's own pool: a full pool is `FileError.Unavailable` (`FetchBusy`), never an unbounded fetch.
 */
import { describe, expect, it } from "vitest";
import { boundsOf } from "../../../src/a2a/client/a2a-download-bounds.js";
import { downloadedFile } from "../../../src/a2a/client/a2a-download.js";
import { SystemClock } from "../../../src/infrastructure/clock.js";
import { FileUnavailableReason } from "../../../src/files/file-errors.js";
import { FilePolicy } from "../../../src/files/file-policy.js";
import { hours, kilobytes, seconds } from "../../../src/units/index.js";

const urlFile = { mediaType: "application/octet-stream", url: "https://files.example/a" };

const bodyOf =
  (size: number): typeof fetch =>
  () =>
    Promise.resolve(new Response(new Uint8Array(size).fill(1)));

const reasonOf = (work: Promise<unknown>): Promise<string | number> =>
  work.then(
    (bytes) => (bytes as Uint8Array).byteLength,
    (error: unknown) => (error as { reason: string }).reason,
  );

describe("#1316: downloadFile under a @FilePolicy", () => {
  it("the policy's maxFileSize caps a download, below the call's maxSize", async () => {
    @FilePolicy({ ttl: hours(1), maxFileSize: kilobytes(2), maxTotalFileSize: kilobytes(2) })
    class Small {}
    const client = {};
    const run = (size: number, maxSize?: ReturnType<typeof kilobytes>) =>
      reasonOf(
        downloadedFile(urlFile, {
          fetcher: bodyOf(size),
          ...boundsOf(client, Small, maxSize),
        }),
      );

    expect(await run(2048)).toBe(2048);
    expect(await run(2049)).toBe(FileUnavailableReason.TooLarge);
    expect(await run(2000, kilobytes(1))).toBe(FileUnavailableReason.TooLarge);
  });

  it("the policy's fetchTimeout ends a slow download", async () => {
    @FilePolicy({ ttl: hours(1), fetchTimeout: 20 as never })
    class Quick {}
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });

    expect(
      await reasonOf(
        downloadedFile(urlFile, {
          fetcher: slow,
          clock: new SystemClock(),
          ...boundsOf({}, Quick, undefined),
        }),
      ),
    ).toBe(FileUnavailableReason.DownloadFailed);
  });

  it("a full pool fails at once with FetchBusy: one running, its queue full", async () => {
    @FilePolicy({
      ttl: hours(1),
      fetchPool: {
        maxConcurrent: 1,
        maxConcurrentPerTenant: 1,
        maxConcurrentPerOwner: 1,
        maxQueuedPerOwner: 1,
      },
    })
    class Narrow {}
    const client = {};
    let release: () => void = () => undefined;
    const held: typeof fetch = () =>
      new Promise((resolve) => {
        release = () => {
          resolve(new Response(new Uint8Array(1)));
        };
      });
    const options = (fetcher: typeof fetch) => ({
      fetcher,
      ...boundsOf(client, Narrow, undefined),
    });

    const first = downloadedFile(urlFile, options(held));
    await new Promise((resolve) => setImmediate(resolve));
    // the tenant's share: 1 running, its queue of 4 (4 slots per running) waiting
    const queued = Array.from({ length: 4 }, () => downloadedFile(urlFile, options(bodyOf(1))));
    await new Promise((resolve) => setImmediate(resolve));
    const busy = await reasonOf(downloadedFile(urlFile, options(bodyOf(1))));
    release();

    expect(busy).toBe(FileUnavailableReason.FetchBusy);
    expect(await reasonOf(first)).toBe(1);
    expect(await Promise.all(queued.map(reasonOf))).toEqual([1, 1, 1, 1]);
  });

  it("with no policy: the client's own default pool, the call's maxSize alone", () => {
    const a = {};
    const b = {};

    expect(boundsOf(a, undefined, undefined).slots).toBe(boundsOf(a, undefined, undefined).slots);
    expect(boundsOf(a, undefined, undefined).slots).not.toBe(
      boundsOf(b, undefined, undefined).slots,
    );
    expect(boundsOf(a, undefined, kilobytes(3)).maxSize).toBe(kilobytes(3));
    expect(seconds(1)).toBe(1000);
  });
});
