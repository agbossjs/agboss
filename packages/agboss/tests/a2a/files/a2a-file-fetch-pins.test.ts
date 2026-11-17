/**
 * #1244: the fetch of a file by url (a2a-file-fetch.ts) over a scripted transport: each refusal with
 * its code and its words, the allowed origins and the redirects hop by hop (at most three), the
 * status range, the body cap at the byte, a body that fails, the deadline and the request's end,
 * and what the fetch leaves behind (a cancelled read, a released timer, no unhandled rejection).
 */
import { afterEach, describe, expect, it } from "vitest";
import { fetchedFile, MAX_REDIRECTS } from "../../../src/a2a/files/a2a-file-fetch.js";
import {
  FileAddressDeniedError,
  type FileHttpResponse,
  type FileTransport,
} from "../../../src/a2a/files/a2a-file-transport.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { kilobytes, type Milliseconds, seconds } from "../../../src/units/index.js";

const ORIGIN = "https://files.example";
const CLOCK_START = new Date("2026-01-05T09:00:00.000Z");

/** What one scripted answer is: a status, a Location, and the body's chunks (a chunk that is an Error fails the body). */
interface Answer {
  readonly status: number;
  readonly location?: string;
  readonly chunks?: readonly (Uint8Array | Error)[];
}

interface Scripted {
  readonly transport: FileTransport;
  readonly asked: string[];
  /** The failure each cancelled read named (`undefined` for none), in order. */
  readonly cancels: (string | undefined)[];
}

/** A transport answering each url from `answers` (by href; `*` for any other). */
function scripted(answers: Readonly<Record<string, Answer | Error>>): Scripted {
  const asked: string[] = [];
  const cancels: (string | undefined)[] = [];
  const transport: FileTransport = (url) => {
    asked.push(url.href);
    const answer = answers[url.href] ?? answers["*"];
    if (answer === undefined) return Promise.reject(new Error("unreachable"));
    if (answer instanceof Error) return Promise.reject(answer);
    const response: FileHttpResponse = {
      status: answer.status,
      location: answer.location,
      body: (async function* () {
        for (const chunk of answer.chunks ?? []) {
          if (chunk instanceof Error) throw chunk;
          yield chunk;
        }
      })(),
      cancel: (failure) => {
        cancels.push(failure);
      },
    };
    return Promise.resolve(response);
  };
  return { transport, asked, cancels };
}

const bytes = (size: number): Uint8Array => new Uint8Array(size).fill(0x61);

interface Options {
  readonly url?: string;
  readonly allowed?: readonly string[];
  readonly maxBytes?: number;
  readonly clock?: Pick<VirtualClock, "sleep">;
  readonly timeout?: Milliseconds;
  readonly signal?: AbortSignal;
}

/** The file's bytes, as plain `Uint8Array` data (the fetch's own are a `Buffer`). */
const fetched = async (transport: FileTransport, options: Options = {}): Promise<Uint8Array> =>
  Uint8Array.from(
    await fetchedFile({
      url: options.url ?? `${ORIGIN}/a.pdf`,
      allowedOrigins: options.allowed ?? [ORIGIN],
      maxBytes: kilobytes((options.maxBytes ?? 100) / 1024),
      transport,
      clock: options.clock ?? new VirtualClock(CLOCK_START),
      timeout: options.timeout ?? seconds(10),
      signal: options.signal ?? new AbortController().signal,
    }),
  );

/** What a refusal is: its stable code and its words. */
const refusal = (code: string, message: string) => ({ message, metadata: { code } });

describe("#1244 the url and its origin", () => {
  it("U1 a text that is no url, a url with a user or a password: refused before any request", async () => {
    const { transport, asked } = scripted({ "*": { status: 200 } });
    await expect(fetched(transport, { url: "not a url" })).rejects.toMatchObject(
      refusal("a2a.file-url-invalid", "the file's url is not a URL"),
    );
    for (const url of [
      `https://user@files.example/a`,
      `https://user:pw@files.example/a`,
      `https://:pw@files.example/a`,
    ])
      await expect(fetched(transport, { url }), url).rejects.toMatchObject(
        refusal("a2a.file-origin-denied", "the file's url carries a user or a password"),
      );
    expect(asked).toEqual([]);
  });

  it("U2 no origin listed is no file by url; another origin, scheme or port is not allowed", async () => {
    const { transport, asked } = scripted({ "*": { status: 200 } });
    await expect(fetched(transport, { allowed: [] })).rejects.toMatchObject(
      refusal("a2a.file-url-not-allowed", "this agent takes no file by url"),
    );
    for (const url of [
      "https://other.example/a",
      "http://files.example/a",
      "https://files.example:8443/a",
    ])
      await expect(fetched(transport, { url }), url).rejects.toMatchObject(
        refusal("a2a.file-origin-denied", "the file's url is on an origin not allowed"),
      );
    // an `http:` origin in the list is no way round the scheme
    await expect(
      fetched(transport, { url: "http://files.example/a", allowed: ["http://files.example"] }),
    ).rejects.toMatchObject(
      refusal("a2a.file-origin-denied", "the file's url is on an origin not allowed"),
    );
    expect(asked).toEqual([]);
  });

  it("U3 an allowed origin is fetched, with its path and query", async () => {
    const { transport, asked } = scripted({ "*": { status: 200, chunks: [bytes(3)] } });
    expect(await fetched(transport, { url: `${ORIGIN}/a/b?x=1` })).toEqual(bytes(3));
    expect(asked).toEqual([`${ORIGIN}/a/b?x=1`]);
  });
});

describe("#1244 redirects", () => {
  const to = (location: string): Answer => ({ status: 302, location });

  it("D1 each of the five redirect statuses is followed, the target judged as the first url was", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { transport, asked, cancels } = scripted({
        [`${ORIGIN}/a.pdf`]: { status, location: "/b.pdf" },
        [`${ORIGIN}/b.pdf`]: { status: 200, chunks: [bytes(2)] },
      });
      expect(await fetched(transport), String(status)).toEqual(bytes(2));
      expect(asked).toEqual([`${ORIGIN}/a.pdf`, `${ORIGIN}/b.pdf`]);
      expect(cancels).toEqual([undefined]);
    }
  });

  it("D2 three redirects are followed; a fourth is `redirects too often`, its read cancelled", async () => {
    const hops = (count: number): Record<string, Answer> => ({
      ...Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${ORIGIN}/${index === 0 ? "a.pdf" : `h${String(index)}`}`,
          to(`/h${String(index + 1)}`),
        ]),
      ),
      [`${ORIGIN}/h${String(count)}`]: { status: 200, chunks: [bytes(1)] },
    });
    expect(MAX_REDIRECTS).toBe(3);
    const three = scripted(hops(3));
    expect(await fetched(three.transport)).toEqual(bytes(1));
    expect(three.asked).toHaveLength(4);

    const four = scripted(hops(4));
    await expect(fetched(four.transport)).rejects.toMatchObject(
      refusal("a2a.file-fetch-failed", "the file's url redirects too often"),
    );
    expect(four.asked).toHaveLength(4);
    expect(four.cancels).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("D3 a redirect with no Location is `redirects too often`", async () => {
    const { transport, cancels } = scripted({ "*": { status: 302 } });
    await expect(fetched(transport)).rejects.toMatchObject(
      refusal("a2a.file-fetch-failed", "the file's url redirects too often"),
    );
    expect(cancels).toEqual([undefined]);
  });

  it("D4 a target on another origin, another scheme, with a user, or no url at all is refused as a redirect", async () => {
    for (const [location, code, message] of [
      [
        "https://other.example/x",
        "a2a.file-origin-denied",
        "the file's url redirects to an origin not allowed",
      ],
      [
        "http://files.example/x",
        "a2a.file-origin-denied",
        "the file's url redirects to an origin not allowed",
      ],
      [
        "https://files.example:9/x",
        "a2a.file-origin-denied",
        "the file's url redirects to an origin not allowed",
      ],
      [
        "https://u:p@files.example/x",
        "a2a.file-origin-denied",
        "the file's url carries a user or a password",
      ],
      ["http://[", "a2a.file-url-invalid", "the file's url is not a URL"],
    ] as const) {
      const { transport, asked } = scripted({ "*": to(location) });
      await expect(fetched(transport), location).rejects.toMatchObject(refusal(code, message));
      expect(asked, location).toHaveLength(1);
    }
  });

  it("D5 a relative target is resolved against the url it redirected from", async () => {
    const { transport, asked } = scripted({
      [`${ORIGIN}/dir/a.pdf`]: to("b.pdf?q=1"),
      [`${ORIGIN}/dir/b.pdf?q=1`]: { status: 200, chunks: [bytes(1)] },
    });
    await fetched(transport, { url: `${ORIGIN}/dir/a.pdf` });
    expect(asked).toEqual([`${ORIGIN}/dir/a.pdf`, `${ORIGIN}/dir/b.pdf?q=1`]);
  });
});

describe("#1244 the status", () => {
  it("S1 200 and 299 are a file; 199, 300, 304, 404 and 500 are not, their read cancelled", async () => {
    for (const status of [200, 204, 299]) {
      const { transport } = scripted({ "*": { status, chunks: [bytes(1)] } });
      expect(await fetched(transport), String(status)).toEqual(bytes(1));
    }
    for (const status of [100, 199, 300, 304, 404, 500]) {
      const { transport, cancels } = scripted({ "*": { status, chunks: [bytes(1)] } });
      await expect(fetched(transport), String(status)).rejects.toMatchObject(
        refusal("a2a.file-fetch-failed", "the file could not be fetched"),
      );
      expect(cancels, String(status)).toEqual([undefined]);
    }
  });
});

describe("#1244 the body's cap", () => {
  it("B1 exactly maxBytes is the file; one byte more is `too large`, the read cancelled with that failure", async () => {
    const exact = scripted({ "*": { status: 200, chunks: [bytes(60), bytes(40)] } });
    expect(await fetched(exact.transport)).toEqual(bytes(100));
    expect(exact.cancels).toEqual([]);

    const over = scripted({ "*": { status: 200, chunks: [bytes(60), bytes(41)] } });
    await expect(fetched(over.transport)).rejects.toMatchObject(
      refusal("a2a.file-too-large", "a file is larger than this agent takes"),
    );
    expect(over.cancels).toEqual(["a2a.file-too-large"]);
  });

  it("B2 a body that is too large at its first chunk is refused at that chunk, the rest unread", async () => {
    let read = 0;
    const transport: FileTransport = () =>
      Promise.resolve({
        status: 200,
        location: undefined,
        body: (async function* () {
          read += 1;
          yield bytes(1000);
          read += 1;
          yield bytes(1);
        })(),
        cancel: () => undefined,
      });
    await expect(fetched(transport)).rejects.toMatchObject({
      metadata: { code: "a2a.file-too-large" },
    });
    expect(read).toBe(1);
  });

  it("B3 a body that fails is `could not be fetched`; one that fails at exactly maxBytes too; a too-large one keeps its code", async () => {
    const failing = scripted({ "*": { status: 200, chunks: [bytes(10), new Error("reset")] } });
    await expect(fetched(failing.transport)).rejects.toMatchObject(
      refusal("a2a.file-fetch-failed", "the file could not be fetched"),
    );
    const atCap = scripted({ "*": { status: 200, chunks: [bytes(100), new Error("reset")] } });
    await expect(fetched(atCap.transport)).rejects.toMatchObject(
      refusal("a2a.file-fetch-failed", "the file could not be fetched"),
    );
    const failsFirst = scripted({ "*": { status: 200, chunks: [new Error("reset")] } });
    await expect(fetched(failsFirst.transport)).rejects.toMatchObject({
      metadata: { code: "a2a.file-fetch-failed" },
    });
  });

  it("B4 an empty body is an empty file", async () => {
    const { transport } = scripted({ "*": { status: 200 } });
    expect(await fetched(transport)).toEqual(new Uint8Array());
  });
});

describe("#1244 what the transport fails with", () => {
  it("T1 a denied address is `address denied`; any other failure is `could not be fetched`", async () => {
    await expect(
      fetched(scripted({ "*": new FileAddressDeniedError() }).transport),
    ).rejects.toMatchObject(
      refusal("a2a.file-address-denied", "the file's host is an address never fetched from"),
    );
    await expect(fetched(scripted({ "*": new Error("boom") }).transport)).rejects.toMatchObject(
      refusal("a2a.file-fetch-failed", "the file could not be fetched"),
    );
  });
});

describe("#1244 the deadline and the request's end", () => {
  const settled = { current: false };
  afterEach(() => {
    settled.current = false;
  });

  it("A1 a transport that never answers fails at the timeout, not before", async () => {
    const clock = new VirtualClock(CLOCK_START);
    const silent: FileTransport = () => new Promise(() => undefined);
    const outcome = fetched(silent, { clock, timeout: seconds(10) }).catch(
      (error: unknown) => error,
    );
    void outcome.then(() => {
      settled.current = true;
    });

    await clock.advance(seconds(9));
    expect(settled.current).toBe(false);
    await clock.advance(seconds(1));
    expect(await outcome).toMatchObject(
      refusal("a2a.file-fetch-failed", "the file could not be fetched in time"),
    );
  });

  it("A2 the request's end fails it the same way; a signal already aborted does, whatever else is wrong with the url", async () => {
    const ended = new AbortController();
    const silent: FileTransport = () => new Promise(() => undefined);
    const outcome = fetched(silent, { signal: ended.signal });
    ended.abort();
    await expect(outcome).rejects.toMatchObject(
      refusal("a2a.file-fetch-failed", "the file could not be fetched in time"),
    );

    for (const url of ["not a url", "https://elsewhere.example/a"])
      await expect(
        fetched(scripted({ "*": { status: 200 } }).transport, { url, signal: AbortSignal.abort() }),
        url,
      ).rejects.toMatchObject(
        refusal("a2a.file-fetch-failed", "the file could not be fetched in time"),
      );
  });

  it("A2b a signal that fired before the fetch began fails a transport that never answers at once", async () => {
    const silent: FileTransport = () => new Promise(() => undefined);
    await expect(fetched(silent, { signal: AbortSignal.abort() })).rejects.toMatchObject(
      refusal("a2a.file-fetch-failed", "the file could not be fetched in time"),
    );
  });

  it("A3 an error that is not the deadline's is passed on whole, while the signal is live", async () => {
    await expect(
      fetched(scripted({ "*": { status: 200, chunks: [bytes(500)] } }).transport),
    ).rejects.toMatchObject({ metadata: { code: "a2a.file-too-large" } });
  });

  it("A4 the timer is released when the fetch ends, by its file or by its failure", async () => {
    const signals: AbortSignal[] = [];
    const clock = {
      sleep: (_delay: Milliseconds, signal?: AbortSignal): Promise<void> => {
        if (signal !== undefined) signals.push(signal);
        return new Promise(() => undefined);
      },
    };
    await fetched(scripted({ "*": { status: 200, chunks: [bytes(1)] } }).transport, { clock });
    await fetched(scripted({ "*": { status: 404 } }).transport, { clock }).catch(() => undefined);
    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("A5 a fetch that fails after the deadline's refusal leaves no unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const ended = new AbortController();
      let fail: (error: Error) => void = () => undefined;
      const late: FileTransport = () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        });
      const outcome = fetched(late, { signal: ended.signal }).catch(() => undefined);
      ended.abort();
      await outcome;
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(rejections).toEqual([]);
  });
});
