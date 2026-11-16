/**
 * #1138: the file fetch's own exchange over a checked TLS socket, against a raw local TLS server
 * that writes exactly the bytes each case gives (cut into pieces, slowly, or not at all): the
 * request it sends, each framing read to its end, an interim response skipped, and every way it
 * fails — a close before or inside the body, a malformed head, an abort — destroying the socket.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Server, type TLSSocket } from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exchangeOver, type FileExchange } from "../../../src/a2a/files/a2a-file-exchange.js";
import { RESPONSE_MALFORMED } from "../../../src/a2a/files/a2a-file-http.js";

const HOST = "files.example.test";
type Script = (socket: TLSSocket, request: string) => void;

let directory: string;
let server: Server;
let port: number;
let ca: Buffer;
let script: Script = () => undefined;
const received: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "agboss-exchange-"));
  const key = join(directory, "host.key");
  const cert = join(directory, "host.crt");
  await promisify(execFile)("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${HOST}`],
    ...["-addext", `subjectAltName=DNS:${HOST}`],
  ]);
  ca = await readFile(cert);
  server = createServer({ key: await readFile(key), cert: ca }, (socket) => {
    let request = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      request += chunk.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      received.push(request);
      script(socket, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

const secureSocket = (): TLSSocket =>
  connect({ host: "127.0.0.1", port, servername: HOST, ca: [ca] });

/** Writes `parts` one after another, a turn of the loop apart, then ends (or not). */
const writes =
  (parts: readonly string[], end = true): Script =>
  (socket) => {
    const next = (index: number): void => {
      const part = parts[index];
      if (part === undefined) {
        if (end) socket.end();
        return;
      }
      socket.write(Buffer.from(part, "latin1"), () => {
        setTimeout(() => {
          next(index + 1);
        }, 2);
      });
    };
    next(0);
  };

async function bodyOf(exchange: FileExchange): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of exchange.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("latin1");
}

async function exchanged(
  given: Script,
  signal = new AbortController().signal,
): Promise<{ exchange: FileExchange; secure: TLSSocket }> {
  script = given;
  received.length = 0;
  const secure = secureSocket();
  const exchange = await exchangeOver(secure, new URL(`https://${HOST}/f.pdf?a=1#x`), signal);
  return { exchange, secure };
}

const closed = (socket: TLSSocket): Promise<boolean> =>
  socket.destroyed
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        socket.once("close", () => {
          resolve(true);
        });
      });

describe("#1138 the exchange reads each framing to its end", () => {
  it("E1 the request's bytes; a length-framed body; the socket closed after it", async () => {
    const { exchange, secure } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel", "lo", "EXTRA"], false),
    );

    expect(received).toEqual([
      `GET /f.pdf?a=1 HTTP/1.1\r\nHost: ${HOST}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
    ]);
    expect(exchange.status).toBe(200);
    expect(await bodyOf(exchange)).toBe("hello");
    expect((await exchange.ended).isComplete).toBe(true);
    expect(await closed(secure)).toBe(true);
  });

  it("E2 a head and a chunked body cut byte by byte, an interim 103 first", async () => {
    const response =
      "HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n" +
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
    const { exchange } = await exchanged(writes(response.split(/(?=[\s\S])/u), false));

    expect(exchange.status).toBe(200);
    expect(await bodyOf(exchange)).toBe("abcde");
    expect((await exchange.ended).isComplete).toBe(true);
  });

  it("E3 a body to the connection's close; a redirect's Location; a 204 with no body", async () => {
    const toClose = await exchanged(writes(["HTTP/1.1 200 OK\r\n\r\nall", " of it"]));
    expect(await bodyOf(toClose.exchange)).toBe("all of it");
    expect((await toClose.exchange.ended).isComplete).toBe(true);

    const moved = await exchanged(
      writes(["HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n"], false),
    );
    expect([moved.exchange.status, moved.exchange.location]).toEqual([302, "/next"]);
    expect(await bodyOf(moved.exchange)).toBe("");

    const empty = await exchanged(writes(["HTTP/1.1 204 No Content\r\n\r\n"], false));
    expect(await bodyOf(empty.exchange)).toBe("");
    expect((await empty.exchange.ended).isComplete).toBe(true);
  });

  it("E4 a body larger than the stream's buffer, read slowly: all of it, in order", async () => {
    const size = 1024 * 1024;
    const { exchange } = await exchanged((socket) => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${String(size)}\r\n\r\n`);
      socket.write(Buffer.alloc(size, 0x61));
    });
    let total = 0;
    for await (const chunk of exchange.body) {
      total += (chunk as Buffer).length;
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(total).toBe(size);
  });
});

describe("#1138 every failure destroys the socket", () => {
  it("F1 a close before the head: rejected ECONNRESET", async () => {
    await expect(exchanged((socket) => socket.end("HTTP/1.1 200"))).rejects.toMatchObject({
      code: "ECONNRESET",
    });
  });

  it("F2 a close inside a length-framed or chunked body: the body fails ECONNRESET, not complete", async () => {
    for (const head of ["Content-Length: 10", "Transfer-Encoding: chunked"]) {
      const { exchange } = await exchanged(writes([`HTTP/1.1 200 OK\r\n${head}\r\n\r\n5\r\nab`]));

      await expect(bodyOf(exchange)).rejects.toMatchObject({ code: "ECONNRESET" });
      expect(await exchange.ended).toMatchObject({
        isComplete: false,
        error: { code: "ECONNRESET" },
      });
    }
  });

  it("F3 a malformed head, a head past MAX_HEAD, a 101: rejected, the socket destroyed", async () => {
    for (const given of [
      writes(["HTTP/1.1 200 OK\r\nbroken\r\n\r\n"], false),
      writes([`HTTP/1.1 200 OK\r\nX: ${"x".repeat(20_000)}`], false),
      writes(["HTTP/1.1 101 Switching Protocols\r\n\r\n"], false),
    ]) {
      script = given;
      const secure = secureSocket();
      await expect(
        exchangeOver(secure, new URL(`https://${HOST}/f`), new AbortController().signal),
      ).rejects.toMatchObject({ code: RESPONSE_MALFORMED });
      expect(secure.destroyed).toBe(true);
    }
  });

  it("F4 a malformed chunk inside the body: the body fails, the socket destroyed", async () => {
    const { exchange, secure } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"], false),
    );

    // the chunk fails in the head's own packet, before anyone reads: kept for the reader, and `ended`
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(bodyOf(exchange)).rejects.toMatchObject({ code: RESPONSE_MALFORMED });
    expect(await exchange.ended).toMatchObject({
      isComplete: false,
      error: { code: RESPONSE_MALFORMED },
    });
    expect(secure.destroyed).toBe(true);
  });

  it("F5 an abort before the head (the peer silent): rejected ABORT_ERR, the socket destroyed", async () => {
    const controller = new AbortController();
    script = () => {
      controller.abort();
    };
    const secure = secureSocket();
    await expect(
      exchangeOver(secure, new URL(`https://${HOST}/f`), controller.signal),
    ).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(await closed(secure)).toBe(true);
  });

  it("F6 an abort already fired: rejected at once, nothing written", async () => {
    const controller = new AbortController();
    controller.abort();
    received.length = 0;
    const secure = secureSocket();

    await expect(
      exchangeOver(secure, new URL(`https://${HOST}/f`), controller.signal),
    ).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(secure.destroyed).toBe(true);
    expect(received).toEqual([]);
  });

  it("F7 an abort inside the body fails it ABORT_ERR; one after the body is whole changes nothing", async () => {
    const controller = new AbortController();
    const cut = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab"], false),
      controller.signal,
    );
    controller.abort();
    await expect(bodyOf(cut.exchange)).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect((await cut.exchange.ended).error).toMatchObject({ code: "ABORT_ERR" });
    expect(cut.secure.destroyed).toBe(true);

    const late = new AbortController();
    const whole = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nab"], false),
      late.signal,
    );
    await closed(whole.secure);
    late.abort();
    expect(await bodyOf(whole.exchange)).toBe("ab");
    expect(await whole.exchange.ended).toEqual({ isComplete: true, error: undefined });
  });

  it("F8 a body destroyed by its reader (a cancel) closes the socket", async () => {
    const { exchange, secure } = await exchanged(
      writes(["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nab"], false),
    );
    exchange.body.destroy();

    expect(await closed(secure)).toBe(true);
    expect(await exchange.ended).toEqual({ isComplete: false, error: undefined });
  });
});
