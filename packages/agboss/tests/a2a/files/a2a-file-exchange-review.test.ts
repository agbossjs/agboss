/**
 * #1244: the findings of the adversarial review of #1241 that live in the exchange — interim
 * responses (a body, a count, the head's budget), a body with no length, the request's bytes, and
 * a TLS socket that fails between its connection and its exchange.
 */
import { connect, type TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exchangeOver } from "../../../src/a2a/files/a2a-file-exchange.js";
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

async function failure(script: Script): Promise<unknown> {
  server.serve(script);
  const secure: TLSSocket = connect({
    host: "127.0.0.1",
    port: server.port,
    servername: HOST,
    ca: [server.ca],
  });
  const error = await exchangeOver(
    secure,
    new URL(`https://${HOST}/f`),
    new AbortController().signal,
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(secure.destroyed).toBe(true);
  return error;
}

const interim = (extra = ""): string => `HTTP/1.1 103 Early Hints\r\n${extra}Link: </a>\r\n\r\n`;
const malformed = (why: string): unknown =>
  expect.objectContaining({
    code: RESPONSE_MALFORMED,
    message: `the file's response is malformed: ${why}`,
  });

describe("#1244 D1 interim responses are bounded", () => {
  it("four are skipped; a fifth is refused", async () => {
    server.serve(
      writes([`${interim().repeat(4)}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`], false),
    );
    const secure = connect({
      host: "127.0.0.1",
      port: server.port,
      servername: HOST,
      ca: [server.ca],
    });
    const exchange = await exchangeOver(
      secure,
      new URL(`https://${HOST}/f`),
      new AbortController().signal,
    );
    expect(exchange.status).toBe(200);
    secure.destroy();

    expect(
      await failure(
        writes([`${interim().repeat(5)}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`], false),
      ),
    ).toEqual(malformed("too many interim responses"));
  });

  it("the interim heads and the final one share one budget of MAX_HEAD: a 1xx that is large leaves less", async () => {
    const pad = (size: number): string => `X-Pad: ${"p".repeat(size - 7)}\r\n`;
    // two interim heads of ~7 KiB and a final one of ~3 KiB: past MAX_HEAD together, each under it alone
    const big = `HTTP/1.1 103 Early Hints\r\n${pad(7000)}\r\n`;
    const final = `HTTP/1.1 200 OK\r\nContent-Length: 2\r\n${pad(3000)}\r\nok`;
    expect(7000 * 2 + 3000).toBeGreaterThan(MAX_HEAD);
    expect(await failure(writes([big + big + final], false))).toEqual(
      malformed("the head is too large"),
    );
  });

  it("an interim response that carries a length or a coding is refused, however empty", async () => {
    for (const extra of ["Content-Length: 5\r\n", "Transfer-Encoding: chunked\r\n"])
      expect(
        await failure(
          writes([`${interim(extra)}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`], false),
        ),
        extra,
      ).toEqual(malformed("an interim response with a body"));
  });

  it("Content-Length: 0 on an interim response is an empty one", async () => {
    server.serve(
      writes(
        [`${interim("Content-Length: 0\r\n")}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`],
        false,
      ),
    );
    const secure = connect({
      host: "127.0.0.1",
      port: server.port,
      servername: HOST,
      ca: [server.ca],
    });
    const exchange = await exchangeOver(
      secure,
      new URL(`https://${HOST}/f`),
      new AbortController().signal,
    );
    expect(exchange.status).toBe(200);
    secure.destroy();
  });
});

describe("#1244 A3 the request is written as one Buffer", () => {
  it("the request head goes out as bytes (latin1), not as a string", async () => {
    server.serve(writes(["HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"], false));
    const secure = connect({
      host: "127.0.0.1",
      port: server.port,
      servername: HOST,
      ca: [server.ca],
    });
    const written: unknown[] = [];
    const write = secure.write.bind(secure);
    Object.defineProperty(secure, "write", {
      value: (chunk: unknown, ...rest: unknown[]) => {
        written.push(chunk);
        return Reflect.apply(write, secure, [chunk, ...rest]) as boolean;
      },
    });
    await exchangeOver(secure, new URL(`https://${HOST}/f`), new AbortController().signal);
    expect(written).toHaveLength(1);
    expect(written[0]).toBeInstanceOf(Buffer);
    secure.destroy();
  });
});

describe("#1244 F1 a body with no length is no file", () => {
  it("a 2xx to the close (HTTP/1.1 or 1.0) is refused: a truncation of it cannot be told", async () => {
    for (const status of [
      "HTTP/1.1 200 OK",
      "HTTP/1.0 200 OK",
      "HTTP/1.1 206 Partial",
      "HTTP/1.1 299 X",
    ])
      expect(await failure(writes([`${status}\r\n\r\n%PDF-1.4 half`])), status).toEqual(
        malformed("a body with no length"),
      );
  });

  it("a redirect or an error to the close is read as before: its body is never used", async () => {
    for (const status of [
      "HTTP/1.1 300 Multiple Choices",
      "HTTP/1.1 302 Found\r\nLocation: /n",
      "HTTP/1.1 404 Not Found",
      "HTTP/1.1 500 Oops",
    ]) {
      server.serve(writes([`${status}\r\n\r\nbody`]));
      const secure = connect({
        host: "127.0.0.1",
        port: server.port,
        servername: HOST,
        ca: [server.ca],
      });
      const exchange = await exchangeOver(
        secure,
        new URL(`https://${HOST}/f`),
        new AbortController().signal,
      );
      expect(exchange.status).toBeGreaterThanOrEqual(300);
      exchange.body.destroy();
    }
  });
});
