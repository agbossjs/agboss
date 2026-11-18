/**
 * #1244: a whole file fetch (the built-in transport, its own connection and exchange, the fetch's
 * bounds) against a hostile server on a simulated public network: duplicate and conflicting
 * lengths, a coding and a length together, chunked bodies with extensions, trailers and bad sizes,
 * an oversized chunk or body, a head too large, a status line with no reason, HTTP/1.0, interim
 * responses, an early close, a drip that never ends against the timeout, a Content-Encoding that
 * must never be decompressed, and a header that tries to inject a line. Each ends in a stable
 * refusal or the file's exact bytes, and the connection is closed.
 */
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  installPublicNetwork,
  loadFileStack,
  PUBLIC,
  type FileStack,
  type PublicNetwork,
} from "./support/public-network.js";
import {
  type Script,
  type ScriptServer,
  startScriptServer,
  writes,
} from "./support/script-server.js";

const HOST = "files.example.test";
const ORIGIN = `https://${HOST}`;
let server: ScriptServer;
let network: PublicNetwork;
let stack: FileStack;

beforeAll(async () => {
  server = await startScriptServer(HOST);
  network = installPublicNetwork(server);
  stack = await loadFileStack();
});
afterAll(async () => {
  network.restore();
  await server.close();
});
beforeEach(() => {
  network.reset();
});

interface Outcome {
  readonly file?: string;
  readonly code?: string;
  readonly message?: string;
  readonly elapsed: number;
}

/** One fetch of `/f` served by `script`: the file as text, or the refusal; the time it took. */
async function fetchedFrom(
  script: Script,
  options: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal; path?: string } = {},
): Promise<Outcome> {
  server.serve(script);
  const started = performance.now();
  try {
    const bytes = await stack.fetchedFile({
      url: `${ORIGIN}${options.path ?? "/f"}`,
      allowedOrigins: [ORIGIN],
      maxBytes: stack.kilobytes((options.maxBytes ?? 1024) / 1024),
      transport: stack.httpsFileTransport,
      clock: stack.systemClock,
      timeout: stack.seconds((options.timeoutMs ?? 5000) / 1000),
      signal: options.signal ?? new AbortController().signal,
    });
    return { file: Buffer.from(bytes).toString("latin1"), elapsed: performance.now() - started };
  } catch (error) {
    const metadata = Reflect.get(Object(error), "metadata") as { code?: string } | undefined;
    return {
      code: metadata?.code,
      message: Reflect.get(Object(error), "message") as string,
      elapsed: performance.now() - started,
    };
  }
}

const FAILED = { code: "a2a.file-fetch-failed", message: "the file could not be fetched" };
const response = (head: string, body = ""): string => `HTTP/1.1 200 OK\r\n${head}\r\n\r\n${body}`;
const served = (...parts: string[]): Script => writes(parts);

describe("#1244 what a server may say, and is read", () => {
  it("G1 a length-framed body; extra bytes after it are never read", async () => {
    expect(
      await fetchedFrom(served(response("Content-Length: 5", "hello and more"))),
    ).toMatchObject({
      file: "hello",
    });
  });

  it("G2 a status line with no reason, with an empty one, and HTTP/1.0 with a length", async () => {
    expect(await fetchedFrom(served("HTTP/1.1 200\r\nContent-Length: 2\r\n\r\nok"))).toMatchObject({
      file: "ok",
    });
    expect(await fetchedFrom(served("HTTP/1.1 200 \r\nContent-Length: 2\r\n\r\nok"))).toMatchObject(
      { file: "ok" },
    );
    expect(
      await fetchedFrom(served("HTTP/1.0 200 OK\r\nContent-Length: 10\r\n\r\nold school")),
    ).toMatchObject({
      file: "old school",
    });
  });

  it("G3 a chunked body with extensions and trailers, however it is cut", async () => {
    const body =
      "5;a=b\r\nhello\r\n1\r\n \r\n5\r\nworld\r\n0;done\r\nTrailer: x\r\nOther: y\r\n\r\n";
    for (const parts of [[body], body.split(/(?=[\s\S])/u)])
      expect(
        await fetchedFrom(served(response("Transfer-Encoding: chunked", parts.join("")))),
      ).toMatchObject({ file: "hello world" });
  });

  it("G4 interim responses first (103, then 100), and a 200 in the same packet", async () => {
    expect(
      await fetchedFrom(
        served(
          "HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 100 Continue\r\n\r\n" +
            response("Content-Length: 2", "ok"),
        ),
      ),
    ).toMatchObject({ file: "ok" });
  });

  it("G5 a redirect to a file on the same origin is followed over a new connection", async () => {
    let calls = 0;
    const before = server.connections();
    const outcome = await fetchedFrom((socket, request) => {
      calls += 1;
      if (request.startsWith("GET /f "))
        writes(["HTTP/1.1 302 Found\r\nLocation: /g\r\nContent-Length: 0\r\n\r\n"], false)(
          socket,
          request,
        );
      else writes([response("Content-Length: 4", "file")])(socket, request);
    });
    expect(outcome).toMatchObject({ file: "file" });
    expect(calls).toBe(2);
    expect(server.connections() - before).toBe(2);
  });

  it("G6 the request has only Host, Accept, Accept-Encoding: identity and Connection: no cookie, no credentials", async () => {
    await fetchedFrom(served(response("Content-Length: 0")));
    expect(server.received).toEqual([
      `GET /f HTTP/1.1\r\nHost: ${HOST}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
    ]);
  });
});

describe("#1244 lengths that disagree", () => {
  it("L1 a duplicate or conflicting Content-Length is refused, the connection closed, nothing returned", async () => {
    for (const lines of [
      "Content-Length: 5\r\nContent-Length: 6",
      "Content-Length: 5, 6",
      "Content-Length: 5,x",
      "Content-Length: -5",
      "Content-Length: 99999999999999999999",
    ]) {
      const outcome = await fetchedFrom(served(response(lines, "hello world")));
      expect(outcome, lines).toMatchObject(FAILED);
      expect(outcome.file).toBeUndefined();
    }
  });

  it("L2 equal duplicates are one length", async () => {
    expect(
      await fetchedFrom(served(response("Content-Length: 5\r\nContent-Length: 5", "hello"))),
    ).toMatchObject({
      file: "hello",
    });
  });

  it("L3 a body shorter than its Content-Length is a failure, never a short file", async () => {
    expect(await fetchedFrom(served(response("Content-Length: 10", "short")))).toMatchObject(
      FAILED,
    );
  });

  it("L4 a chunked body cut before its last chunk, mid-chunk or mid-size-line, is a failure", async () => {
    for (const body of [
      "5\r\nhel",
      "5\r\nhello\r\n",
      "5\r\nhello\r\n0\r\n",
      "5\r\nhello\r\n0\r\nT: x\r\n",
      "5",
    ])
      expect(
        await fetchedFrom(served(response("Transfer-Encoding: chunked", body))),
        body,
      ).toMatchObject(FAILED);
  });
});

describe("#1244 hostile heads", () => {
  it("H1 a folded header, a space before the colon, a bare LF or CR, a NUL: refused", async () => {
    for (const head of [
      "A: b\r\n folded: c",
      "A : b",
      "A: b\nC: d",
      "A: b\rC: d",
      "A: b\0",
      "Content-Length: 2\r\nA\0: b",
    ])
      expect(await fetchedFrom(served(response(head, "ok"))), JSON.stringify(head)).toMatchObject(
        FAILED,
      );
  });

  it("H2 an injected header line in a value (a bare CR or LF) never becomes a second header", async () => {
    // a server that tries to smuggle `Content-Length: 1` into another header's value
    expect(
      await fetchedFrom(
        served(response("X-Evil: a\nContent-Length: 1\r\nContent-Length: 2", "ok")),
      ),
    ).toMatchObject(FAILED);
  });

  it("H3 a head past 16 KiB is refused, with many small headers or one large one", async () => {
    const many = Array.from({ length: 3000 }, (_, index) => `X-${String(index)}: v`).join("\r\n");
    expect(await fetchedFrom(served(response(many, "ok")))).toMatchObject(FAILED);
    expect(await fetchedFrom(served(response(`X: ${"y".repeat(20_000)}`, "ok")))).toMatchObject(
      FAILED,
    );
  });

  it("H4 a head that never ends is refused once it is too large, however slowly it comes", async () => {
    const outcome = await fetchedFrom(
      writes(["HTTP/1.1 200 OK\r\n", `X: ${"y".repeat(17_000)}`, "more"], false),
    );
    expect(outcome).toMatchObject(FAILED);
    expect(outcome.elapsed).toBeLessThan(2000);
  });

  it("H5 a 101 switch of protocols is refused", async () => {
    expect(
      await fetchedFrom(served("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\n\r\n")),
    ).toMatchObject(FAILED);
  });

  it("H6 a status line that is no HTTP/1.x is refused", async () => {
    for (const line of ["HTTP/2 200 OK", "ICY 200 OK", "HTTP/1.1 20 OK", "garbage"])
      expect(
        await fetchedFrom(served(`${line}\r\nContent-Length: 2\r\n\r\nok`)),
        line,
      ).toMatchObject(FAILED);
  });
});

describe("#1244 hostile chunked bodies", () => {
  it("K1 a bad size, a chunk not ended by CRLF, a NUL or an endless trailer line: refused", async () => {
    for (const body of [
      "zz\r\nhello\r\n0\r\n\r\n",
      "-5\r\nhello\r\n0\r\n\r\n",
      "5\r\nhelloXX0\r\n\r\n",
      "5\r\nhello\n0\r\n\r\n",
      "0\r\nT: a\0b\r\n\r\n",
      `0\r\nT: ${"x".repeat(5000)}\r\n\r\n`,
      `0\r\n${("x".repeat(1000) + "\r\n").repeat(20)}\r\n`,
    ])
      expect(
        await fetchedFrom(served(response("Transfer-Encoding: chunked", body))),
        body.slice(0, 20),
      ).toMatchObject(FAILED);
  });

  it("K2 an oversized chunk (a size of terabytes) is read as it arrives and stopped at the cap: too large, not memory", async () => {
    const outcome = await fetchedFrom(
      (socket) => {
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nfffffffffff\r\n");
        const tick = setInterval(() => socket.write(Buffer.alloc(8192, 0x61)), 1);
        socket.on("close", () => {
          clearInterval(tick);
        });
      },
      { maxBytes: 4096 },
    );
    expect(outcome).toMatchObject({ code: "a2a.file-too-large" });
    expect(outcome.elapsed).toBeLessThan(2000);
  });

  it("K3 a chunk size past 13 digits is refused", async () => {
    expect(
      await fetchedFrom(
        served(response("Transfer-Encoding: chunked", "ffffffffffffffff\r\nx\r\n0\r\n\r\n")),
      ),
    ).toMatchObject(FAILED);
  });
});

describe("#1244 a body past the cap", () => {
  it("C1 a Content-Length over the cap is stopped at the cap, the connection closed; at the cap exactly it is the file", async () => {
    const closed: boolean[] = [];
    const outcome = await fetchedFrom(
      (socket) => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000000000\r\n\r\n");
        const tick = setInterval(() => socket.write(Buffer.alloc(8192, 0x61)), 1);
        socket.on("close", () => {
          closed.push(true);
          clearInterval(tick);
        });
      },
      { maxBytes: 4096 },
    );
    expect(outcome).toMatchObject({ code: "a2a.file-too-large" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toEqual([true]);

    const exact = await fetchedFrom(served(response("Content-Length: 4096", "a".repeat(4096))), {
      maxBytes: 4096,
    });
    expect(exact.file).toHaveLength(4096);
    expect(
      await fetchedFrom(served(response("Content-Length: 4097", "a".repeat(4097))), {
        maxBytes: 4096,
      }),
    ).toMatchObject({
      code: "a2a.file-too-large",
    });
  });

  it("C2 a 2xx body with no length, endless, is refused at once: nothing of it is read", async () => {
    const outcome = await fetchedFrom((socket) => {
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
      const tick = setInterval(() => socket.write(Buffer.alloc(8192, 0x61)), 1);
      socket.on("close", () => {
        clearInterval(tick);
      });
    });
    expect(outcome).toMatchObject(FAILED);
    expect(outcome.elapsed).toBeLessThan(2000);
  });
});

describe("#1244 Content-Encoding is never decompressed", () => {
  it("E1 a gzip body is refused whatever it holds: a bomb of 50 MB of zeros in 50 KB is never read, let alone inflated", async () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100 * 1024);
    const outcome = await fetchedFrom(
      served(
        `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${String(bomb.length)}\r\n\r\n${bomb.toString("latin1")}`,
      ),
      { maxBytes: 1024 * 1024 },
    );
    expect(outcome).toMatchObject(FAILED);
    expect(outcome.file).toBeUndefined();
  });

  it("E2 any coding but identity on a 2xx is refused: deflate, br, zstd, stacked, unknown", async () => {
    for (const coding of ["gzip", "deflate", "br", "zstd", "gzip, br", "x-unknown"])
      expect(
        await fetchedFrom(
          served(`HTTP/1.1 200 OK\r\nContent-Encoding: ${coding}\r\nContent-Length: 2\r\n\r\nok`),
        ),
        coding,
      ).toMatchObject(FAILED);
    expect(
      await fetchedFrom(
        served("HTTP/1.1 200 OK\r\nContent-Encoding: identity\r\nContent-Length: 2\r\n\r\nok"),
      ),
    ).toMatchObject({ file: "ok" });
  });

  it("E3 gzip bytes the server does not call encoded are the file's bytes as sent: never inflated", async () => {
    const zipped = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    const outcome = await fetchedFrom(
      served(
        `HTTP/1.1 200 OK\r\nContent-Length: ${String(zipped.length)}\r\n\r\n${zipped.toString("latin1")}`,
      ),
      { maxBytes: 1024 * 1024 },
    );
    expect(Buffer.from(outcome.file ?? "", "latin1").equals(zipped)).toBe(true);
  });

  it("E4 Transfer-Encoding: gzip, chunked is refused, not chunk-decoded into gzip bytes", async () => {
    const zipped = gzipSync(Buffer.from("hello"));
    const chunked = `${zipped.length.toString(16)}\r\n${zipped.toString("latin1")}\r\n0\r\n\r\n`;
    expect(
      await fetchedFrom(served(response("Transfer-Encoding: gzip, chunked", chunked))),
    ).toMatchObject(FAILED);
  });
});

describe("#1244 a server that is too slow", () => {
  it("S1 a head dripped one byte at a time is cut at the timeout, the connection closed", async () => {
    let closed = false;
    const outcome = await fetchedFrom(
      (socket) => {
        let at = 0;
        const head = "HTTP/1.1 200 OK\r\nX-Slow: ".padEnd(5000, "a");
        const tick = setInterval(() => {
          socket.write(head[at] ?? "a");
          at += 1;
        }, 20);
        socket.on("close", () => {
          closed = true;
          clearInterval(tick);
        });
      },
      { timeoutMs: 300 },
    );
    expect(outcome).toMatchObject({
      code: "a2a.file-fetch-failed",
      message: "the file could not be fetched in time",
    });
    expect(outcome.elapsed).toBeGreaterThanOrEqual(250);
    expect(outcome.elapsed).toBeLessThan(1500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(true);
  });

  it("S2 a body dripped under its Content-Length is cut at the timeout, however many bytes already came", async () => {
    let closed = false;
    const outcome = await fetchedFrom(
      (socket) => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n");
        const tick = setInterval(() => socket.write("a"), 20);
        socket.on("close", () => {
          closed = true;
          clearInterval(tick);
        });
      },
      { timeoutMs: 300 },
    );
    expect(outcome).toMatchObject({
      code: "a2a.file-fetch-failed",
      message: "the file could not be fetched in time",
    });
    expect(outcome.elapsed).toBeLessThan(1500);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(true);
  });

  it("S3 a server that says nothing at all is cut at the timeout; so is a drip of interim heads", async () => {
    expect(await fetchedFrom(() => undefined, { timeoutMs: 200 })).toMatchObject({
      message: "the file could not be fetched in time",
    });
    const outcome = await fetchedFrom(
      (socket) => {
        const tick = setInterval(() => socket.write("HTTP/1.1 100 Continue\r\n\r\n"), 5);
        socket.on("close", () => {
          clearInterval(tick);
        });
      },
      { timeoutMs: 300 },
    );
    expect(outcome).toMatchObject(FAILED);
  });

  it("S4 the request's end closes the connection at once", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);
    const outcome = await fetchedFrom(() => undefined, { signal: controller.signal });
    expect(outcome).toMatchObject({ code: "a2a.file-fetch-failed" });
    expect(outcome.elapsed).toBeLessThan(1000);
  });
});

describe("#1244 a connection that closes early", () => {
  it("X1 before any byte, in the head, or in a framed body: a failure", async () => {
    expect(await fetchedFrom((socket) => socket.end())).toMatchObject(FAILED);
    expect(
      await fetchedFrom((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Le")),
    ).toMatchObject(FAILED);
    expect(await fetchedFrom(served(response("Content-Length: 50", "half")))).toMatchObject(FAILED);
  });

  it("X2 a 2xx body with no length is refused, cut or not: a truncation of it cannot be told from its end", async () => {
    expect(
      await fetchedFrom((socket) => {
        socket.write("HTTP/1.1 200 OK\r\n\r\npartial");
        setTimeout(() => socket.end(), 30);
      }),
    ).toMatchObject(FAILED);
  });
});
