/**
 * #1366: `downloadFile` hands out at most `maxSize` bytes, whichever way the bytes come: an inline file over it
 * is refused (`too-large`) as a file by url is, and a file of exactly `maxSize` is handed out.
 */
import { describe, expect, it } from "vitest";
import { A2AFileUnavailableReason } from "../../../../src/a2a/files/a2a-file-errors.js";
import { downloadedFile } from "../../../../src/a2a/client/a2a-download.js";
import { kilobytes } from "../../../../src/units/index.js";

const inlineOf = (size: number) => ({
  mediaType: "application/octet-stream",
  inline: Buffer.alloc(size, 7).toString("base64"),
});

/** Never called: an inline file is read from the descriptor. */
const fetcher: typeof fetch = () => Promise.reject(new Error("no fetch for an inline file"));

/** What a download comes to: its size in bytes, or the reason it is unavailable (never the bytes themselves). */
const outcomeOf = (
  file: ReturnType<typeof inlineOf>,
  options: Parameters<typeof downloadedFile>[1],
): Promise<number | A2AFileUnavailableReason> =>
  downloadedFile(file, options).then(
    (bytes) => bytes.byteLength,
    (error: unknown) => (error as { reason: A2AFileUnavailableReason }).reason,
  );

describe("#1366: the size an inline file may have", () => {
  it("a file of 1500 bytes under a maxSize of 1 KB is refused as too large, one of exactly 1 KB is handed out", async () => {
    const options = { fetcher, maxSize: kilobytes(1) };

    expect(await outcomeOf(inlineOf(1500), options)).toBe(A2AFileUnavailableReason.TooLarge);
    expect(await outcomeOf(inlineOf(1024), options)).toBe(1024);
    expect(await outcomeOf(inlineOf(1025), options)).toBe(A2AFileUnavailableReason.TooLarge);
  });

  it("with no maxSize the default of 10 MB binds", async () => {
    const options = { fetcher };

    expect(await outcomeOf(inlineOf(10 * 1024 * 1024), options)).toBe(10 * 1024 * 1024);
    expect(await outcomeOf(inlineOf(10 * 1024 * 1024 + 1), options)).toBe(
      A2AFileUnavailableReason.TooLarge,
    );
  });
});
