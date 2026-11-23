/**
 * #1366: `downloadFile` of a file by url reads the body up to `maxSize` bytes and no more — summed across chunks,
 * the read stopped at the first byte past it — through the client's own fetch, and says why a file is unavailable:
 * a stored descriptor is another application's (`not-found`), a failed fetch or a refusing origin is `download-failed`
 * or the client's own refusal as it is, a digest that differs is `digest-mismatch`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { downloadedFile } from "../../../src/a2a/client/a2a-download.js";
import { AGBossError } from "../../../src/core/errors.js";
import { A2AFileUnavailableReason } from "../../../src/a2a/files/a2a-file-errors.js";
import { kilobytes } from "../../../src/units/index.js";

const byUrl = { mediaType: "application/octet-stream", url: "https://files.example/a" };

/** A fetch that answers with a body of `chunks`, and notes how it was called. */
function fetching(chunks: readonly Uint8Array[], init: ResponseInit = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = (url, options) => {
    calls.push({ url: String(url), init: options });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return Promise.resolve(new Response(body, init));
  };
  return { fetcher, calls };
}

/** What a download comes to: its size, or the reason it is unavailable, or the error it failed with. */
const outcomeOf = (
  file: Parameters<typeof downloadedFile>[0],
  download: Parameters<typeof downloadedFile>[1],
): Promise<number | A2AFileUnavailableReason | unknown> =>
  downloadedFile(file, download).then(
    (bytes) => bytes.byteLength,
    (error: unknown) => (error as { reason?: A2AFileUnavailableReason }).reason ?? error,
  );

const bytesOf = (size: number): Uint8Array => new Uint8Array(size).fill(7);

describe("#1366: a file by url is bounded by maxSize", () => {
  it("up to maxSize it is read whole, from the url the descriptor names", async () => {
    const { fetcher, calls } = fetching([bytesOf(600), bytesOf(424)]);

    expect(await outcomeOf(byUrl, { fetcher, maxSize: kilobytes(1) })).toBe(1024);
    expect(calls.map((call) => call.url)).toEqual(["https://files.example/a"]);
  });

  it("one byte past maxSize in one chunk is too large", async () => {
    const { fetcher } = fetching([bytesOf(1025)]);

    expect(await outcomeOf(byUrl, { fetcher, maxSize: kilobytes(1) })).toBe(
      A2AFileUnavailableReason.TooLarge,
    );
  });

  it("chunks that are small each but add up past maxSize are too large", async () => {
    const { fetcher } = fetching([bytesOf(600), bytesOf(600)]);

    expect(await outcomeOf(byUrl, { fetcher, maxSize: kilobytes(1) })).toBe(
      A2AFileUnavailableReason.TooLarge,
    );
  });

  it("with no maxSize the default of 10 MB binds, a body without chunks is an empty file", async () => {
    const empty: typeof fetch = () => Promise.resolve(new Response(null));
    const { fetcher } = fetching([bytesOf(10 * 1024 * 1024 + 1)]);

    expect(await outcomeOf(byUrl, { fetcher })).toBe(A2AFileUnavailableReason.TooLarge);
    expect(await outcomeOf(byUrl, { fetcher: empty })).toBe(0);
  });

  it("the caller's signal goes to the fetch; with none, the fetch gets no signal", async () => {
    const withSignal = fetching([bytesOf(1)]);
    const without = fetching([bytesOf(1)]);
    const signal = new AbortController().signal;

    await outcomeOf(byUrl, { fetcher: withSignal.fetcher, signal });
    await outcomeOf(byUrl, { fetcher: without.fetcher });

    expect(withSignal.calls[0]?.init).toEqual({ signal });
    expect(without.calls[0]?.init).toEqual({});
  });
});

describe("#1366: why a file is unavailable", () => {
  it("an answer that is not ok, and a fetch that fails, are download-failed", async () => {
    const refused = fetching([bytesOf(1)], { status: 404 });
    const broken: typeof fetch = () => Promise.reject(new Error("socket closed"));

    expect(await outcomeOf(byUrl, { fetcher: refused.fetcher })).toBe(
      A2AFileUnavailableReason.DownloadFailed,
    );
    expect(await outcomeOf(byUrl, { fetcher: broken })).toBe(
      A2AFileUnavailableReason.DownloadFailed,
    );
  });

  it("an origin the client refuses is said as it is, not as a failed download", async () => {
    const refusal = new AGBossError("the origin is outside the client's origins");
    const refusing: typeof fetch = () => Promise.reject(refusal);

    expect(await outcomeOf(byUrl, { fetcher: refusing })).toBe(refusal);
  });

  it("a stored descriptor is another application's: not-found, nothing fetched", async () => {
    const { fetcher, calls } = fetching([bytesOf(1)]);

    expect(await outcomeOf({ mediaType: "text/plain", fileId: "f-1" }, { fetcher })).toBe(
      A2AFileUnavailableReason.NotFound,
    );
    expect(calls).toEqual([]);
  });

  it("a digest that is not the bytes' is digest-mismatch, one that is lets the file out", async () => {
    const body = bytesOf(10);
    const digest = createHash("sha256").update(body).digest("hex");
    const { fetcher } = fetching([body]);

    expect(await outcomeOf({ ...byUrl, sha256: digest }, { fetcher })).toBe(10);
    expect(
      await outcomeOf({ ...byUrl, sha256: "0".repeat(64) }, { fetcher: fetching([body]).fetcher }),
    ).toBe(A2AFileUnavailableReason.DigestMismatch);
  });
});
