/**
 * #1244: the exchange of a file fetch (a2a-file-exchange.ts) against a raw TLS server that writes
 * hostile bytes: a head at and past MAX_HEAD, interim responses, a body that outruns its reader, an
 * error of the TLS socket, an abort and its listener, a request that cannot be written, and the
 * words of each failure.
 */
import { getEventListeners } from "node:events";
import { connect, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exchangeOver, type FileExchange } from "../../../src/a2a/files/a2a-file-exchange.js";
import { MAX_HEAD, RESPONSE_MALFORMED } from "../../../src/a2a/files/a2a-file-http.js";
import {
  type Script,
  type ScriptServer,
  startScriptServer,
  writes,
} from "./support/script-server.js";

const HOST = "files.example.test";
let server: ScriptServer;
beforeAll(async () => {
  server = await startScriptServer(HOST);
});
afterAll(async () => {
  await server.close();
});

const secureSocket = (servername = HOST): TLSSocket =>
  connect({ host: "127.0.0.1", port: server.port, servername, ca: [server.ca] });

const URL_OF = new URL(`https://${HOST}/f.pdf`);

async function exchanged(
  script: Script,
  signal = new AbortController().signal,
): Promise<{ exchange: FileExchange; secure: TLSSocket }> {
  server.serve(script);
  const secure = secureSocket();
  return { exchange: await exchangeOver(secure, URL_OF, signal), secure };
}

async function rejection(script: Script, signal = new AbortController().signal): Promise<unknown> {
  server.serve(script);
  const secure = secureSocket();
  const failure = await exchangeOver(secure, URL_OF, signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(secure.destroyed).toBe(true);
  return failure;
}

async function bodyOf(exchange: FileExchange): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of exchange.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("latin1");
}

/** A response head of exactly `length` bytes before its blank line. */
const headOfLength = (length: number): string => {
  const line = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Pad: ";
  return line + "p".repeat(length - line.length);
};

describe("#1244 the head's size", () => {
  it("L1 a head of exactly MAX_HEAD bytes is read; one byte more is malformed", async () => {
    const exact = await exchanged(writes([`${headOfLength(MAX_HEAD)}\r\n\r\nok`], false));
    expect(exact.exchange.status).toBe(200);
    expect(await bodyOf(exact.exchange)).toBe("ok");

    expect(
      await rejection(writes([`${headOfLength(MAX_HEAD + 1)}\r\n\r\nok`], false)),
    ).toMatchObject({
      code: RESPONSE_MALFORMED,
      message: "the file's response is malformed: the head is too large",
    });
  });

  it("L2 MAX_HEAD bytes with no blank line yet are waited on; MAX_HEAD + 1 are refused at once", async () => {
    const waited = await exchanged(writes([headOfLength(MAX_HEAD), "\r\n\r\nok"], false));
    expect(waited.exchange.status).toBe(200);
    expect(await bodyOf(waited.exchange)).toBe("ok");

    expect(await rejection(writes([headOfLength(MAX_HEAD + 1)], false))).toMatchObject({
      code: RESPONSE_MALFORMED,
      message: "the file's response is malformed: the head is too large",
    });
  });

  it("L3 a head of many small headers past MAX_HEAD is refused, whatever their number", async () => {
    const lines = Array.from({ length: 3000 }, (_, index) => `X-${String(index)}: v`);
    expect(
      await rejection(writes([`HTTP/1.1 200 OK\r\n${lines.join("\r\n")}\r\n\r\n`], false)),
    ).toMatchObject({ code: RESPONSE_MALFORMED });
  });
});

describe("#1244 interim responses and the switch of protocols", () => {
  it("I1 several interim heads in one packet and in pieces are skipped; a 101 is refused with its reason", async () => {
    const hints = "HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 100 Continue\r\n\r\n";
    const { exchange } = await exchanged(
      writes([hints + "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"], false),
    );
    expect(exchange.status).toBe(200);
    expect(await bodyOf(exchange)).toBe("ok");

    expect(
      await rejection(writes(["HTTP/1.1 103 Early\r\n\r\nHTTP/1.1 101 Switching\r\n\r\n"], false)),
    ).toMatchObject({
      code: RESPONSE_MALFORMED,
      message: "the file's response is malformed: a switch of protocols",
    });
  });

  it("I2 a malformed interim head is refused like every other head", async () => {
    expect(
      await rejection(
        writes(["HTTP/1.1 103 Early\r\nbroken\r\n\r\nHTTP/1.1 200 OK\r\n\r\n"], false),
      ),
    ).toMatchObject({ code: RESPONSE_MALFORMED });
  });

  it("I3 an endless run of interim heads is refused after a few, whatever the deadline", async () => {
    const failure = rejection((socket) => {
      const tick = setInterval(() => socket.write("HTTP/1.1 100 Continue\r\n\r\n".repeat(50)), 1);
      socket.on("close", () => {
        clearInterval(tick);
      });
    });
    expect(await failure).toMatchObject({
      code: RESPONSE_MALFORMED,
      message: "the file's response is malformed: too many interim responses",
    });
  });
});

describe("#1244 a body that outruns its reader", () => {
  it("P1 the socket is paused while the body's buffer is full, and resumed by the reader", async () => {
    const size = 8 * 1024 * 1024;
    const { exchange, secure } = await exchanged((socket) => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${String(size)}\r\n\r\n`);
      socket.write(Buffer.alloc(size, 0x61));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(secure.isPaused()).toBe(true);
    expect(exchange.body.readableLength).toBeLessThan(size);

    let total = 0;
    for await (const chunk of exchange.body) total += (chunk as Buffer).length;
    expect(total).toBe(size);
  });
});

describe("#1244 the socket's own failures", () => {
  it("T1 a TLS error (a certificate for another name) rejects with it, the socket destroyed", async () => {
    server.serve(() => undefined);
    const secure = secureSocket("another.example.test");
    const failure = await exchangeOver(secure, URL_OF, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(secure.destroyed).toBe(true);
  });

  it("T2 a request that cannot be written (a target that is no request target) rejects, the socket destroyed", async () => {
    server.serve(() => undefined);
    const secure = secureSocket();
    const url = new URL(URL_OF);
    Object.defineProperty(url, "pathname", { value: "/a\r\nX: y" });

    const failure = await exchangeOver(secure, url, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: RESPONSE_MALFORMED,
      message: "the file's response is malformed: the request target",
    });
    expect(secure.destroyed).toBe(true);
    expect(server.received.some((request) => request.includes("X: y"))).toBe(false);
  });
});

describe("#1244 the words of each failure", () => {
  it("W1 a close before the head is `socket hang up`, ECONNRESET", async () => {
    const failure = await rejection((socket) => socket.end("HTTP/1.1 200"));
    expect(failure).toMatchObject({ message: "socket hang up", code: "ECONNRESET" });
    expect(failure).toBeInstanceOf(Error);
  });

  it("W2 a close inside a framed body is `aborted`, ECONNRESET", async () => {
    const { exchange } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab"]),
    );
    await expect(bodyOf(exchange)).rejects.toMatchObject({
      message: "aborted",
      code: "ECONNRESET",
    });
  });

  it("W3 an abort is `The operation was aborted`, named AbortError, ABORT_ERR", async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = await rejection(() => undefined, controller.signal);
    expect(failure).toMatchObject({
      message: "The operation was aborted",
      name: "AbortError",
      code: "ABORT_ERR",
    });
  });

  it("W4 a body failed by a non-Error value is cut as `aborted`", async () => {
    // a close inside a chunked body whose failure is not the parser's: the cut error
    const { exchange } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nab"]),
    );
    expect((await exchange.ended).error).toMatchObject({ message: "aborted", code: "ECONNRESET" });
  });
});

describe("#1244 the abort listener", () => {
  it("A1 is removed when the socket closes, and when the abort fires; none stays on a long-lived signal", async () => {
    const controller = new AbortController();
    const { exchange, secure } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"]),
      controller.signal,
    );
    expect(await bodyOf(exchange)).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secure.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("A2 an abort that fires is heard once and its listener gone at once", async () => {
    const controller = new AbortController();
    const { exchange } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab"], false),
      controller.signal,
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await expect(bodyOf(exchange)).rejects.toMatchObject({ code: "ABORT_ERR" });
  });

  it("A3 an abort after the body is whole leaves it whole", async () => {
    const controller = new AbortController();
    const { exchange } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"], false),
      controller.signal,
    );
    expect(await bodyOf(exchange)).toBe("ok");
    controller.abort();
    expect(await exchange.ended).toEqual({ isComplete: true, error: undefined });
  });
});

describe("#1244 a body to the close", () => {
  it("C1 a body the reader cancels is not complete, whatever the server does after", async () => {
    const { exchange } = await exchanged(writes(["HTTP/1.1 404 Nope\r\n\r\npart"], false));
    exchange.body.destroy();
    expect(await exchange.ended).toEqual({ isComplete: false, error: undefined });
  });
});
