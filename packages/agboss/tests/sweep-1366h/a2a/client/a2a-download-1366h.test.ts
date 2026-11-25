/**
 * #1366: a download of a file by url stops reading at the first byte past `maxSize` (the rest of the body is never pulled),
 * is handed no signal key when it has no signal and its signal when it has, and a descriptor that names neither a url nor
 * inline bytes is read as an empty address / empty file rather than something else.
 */
import { describe, expect, it } from "vitest";
import { downloadedFile } from "../../../../src/a2a/client/a2a-download.js";
import { kilobytes } from "../../../../src/units/index.js";

const byUrl = { mediaType: "application/octet-stream", url: "https://files.example/a" };

describe("#1366: a download is bounded while it is read, not after", () => {
  it("a body that would run on for 50 chunks is cut after the chunk that passes maxSize", async () => {
    let pulled = 0;
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              if (pulled > 50) controller.close();
              else controller.enqueue(new Uint8Array(600));
            },
          }),
        ),
      );

    const failure = await downloadedFile(byUrl, { fetcher, maxSize: kilobytes(1) }).then(
      () => undefined,
      (error: unknown) => (error as { reason?: string }).reason,
    );

    expect(failure).toBe("too-large");
    expect(pulled).toBeLessThanOrEqual(5);
  });
});

describe("#1366: what the fetch is handed", () => {
  it("no signal key without a signal, the caller's signal when there is one", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const fetcher: typeof fetch = (_url, init) => {
      inits.push(init);
      return Promise.resolve(new Response(new Uint8Array([1])));
    };
    const controller = new AbortController();

    await downloadedFile(byUrl, { fetcher });
    await downloadedFile(byUrl, { fetcher, signal: controller.signal });

    expect(inits[0]).toStrictEqual({});
    expect(inits[1]?.signal).toBe(controller.signal);
  });
});

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("#1366: a descriptor with no address and no bytes", () => {
  it("one with no url is fetched from an empty address, one with no inline bytes is an empty file", async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = (url) => {
      urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return Promise.resolve(new Response(new Uint8Array([9])));
    };

    await downloadedFile({ mediaType: "text/plain" }, { fetcher });
    // an inline descriptor (inline set, bytes empty) is the empty file; one with neither is read as a url
    const empty = await downloadedFile(
      { mediaType: "text/plain", inline: "", sha256: EMPTY_SHA256 },
      {
        fetcher,
      },
    );

    expect(urls).toEqual([""]);
    expect(empty.byteLength).toBe(0);
  });
});
