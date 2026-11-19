/**
 * #1312: only a 200 is a file. A 206 is part of one (no `Range` is ever sent), a 204 has none and
 * any other 2xx is not what was asked for: each is a refused fetch with the stable code and words,
 * none of what the server wrote. A 200 whose body ends short of its Content-Length is no file either.
 * The whole fetch, over the built-in transport, against a raw TLS server on a simulated public network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  installPublicNetwork,
  loadFileStack,
  type FileStack,
  type PublicNetwork,
} from "./support/public-network.js";
import { type ScriptServer, startScriptServer, writes } from "./support/script-server.js";

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

/** One fetch of `/f` answered with `reply` as written: the file's text, or the refusal's code, message and cause text. */
async function fetchedAfter(reply: string) {
  server.serve(writes([reply]));
  try {
    const bytes = await stack.fetchedFile({
      url: `${ORIGIN}/f`,
      allowedOrigins: [ORIGIN],
      maxBytes: stack.kilobytes(1),
      transport: stack.httpsFileTransport,
      clock: stack.systemClock,
      timeout: stack.seconds(5),
      signal: new AbortController().signal,
    });
    return { file: Buffer.from(bytes).toString("latin1") };
  } catch (error) {
    const metadata = Reflect.get(Object(error), "metadata") as { code?: string } | undefined;
    return { code: metadata?.code, message: Reflect.get(Object(error), "message") as string };
  }
}

const FAILED = { code: "a2a.file-fetch-failed", message: "the file could not be fetched" };

describe("#1312 the status of a file", () => {
  it("T1 a 200 is the file", async () => {
    expect(await fetchedAfter("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")).toEqual({
      file: "hello",
    });
  });

  it("T2 a 201, 203, 205, 206 and 299 with a body are refused, none of their words in the refusal", async () => {
    for (const status of [201, 203, 205, 206, 299]) {
      const outcome = await fetchedAfter(
        `HTTP/1.1 ${String(status)} SECRET-REASON\r\nContent-Length: 11\r\nX-Note: SECRET-HEADER\r\n\r\nSECRET-BODY`,
      );
      expect(outcome, String(status)).toEqual(FAILED);
    }
  });

  it("T3 a 206 with a Content-Range is a part of a file, refused", async () => {
    const outcome = await fetchedAfter(
      "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-4/100\r\nContent-Length: 5\r\n\r\nhello",
    );
    expect(outcome).toEqual(FAILED);
  });

  it("T4 a 204 and a 205 with no body are no empty file", async () => {
    expect(await fetchedAfter("HTTP/1.1 204 No Content\r\n\r\n")).toEqual(FAILED);
    expect(await fetchedAfter("HTTP/1.1 205 Reset Content\r\nContent-Length: 0\r\n\r\n")).toEqual(
      FAILED,
    );
  });

  it("T5 a 200 whose body ends before its Content-Length is no file, the bytes read are not given", async () => {
    expect(await fetchedAfter("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort")).toEqual(
      FAILED,
    );
  });

  it("T6 a 200 that carries a Content-Range is a part of a file, refused, none of its words in the refusal", async () => {
    const outcome = await fetchedAfter(
      "HTTP/1.1 200 OK\r\nContent-Range: bytes 0-10/SECRET-100\r\nContent-Length: 11\r\n\r\nSECRET-BODY",
    );
    expect(outcome).toEqual(FAILED);
  });
});
