/**
 * #1244: the built-in transport (a2a-file-transport.ts) on a simulated public network: what it
 * hands the fetch (status, Location, the body, a cancel that closes the connection), the one span
 * each request makes and how it ends (a whole body, a refused status, a cancelled read, a cut or an
 * aborted body, a request that fails before a response), and the refusals it maps.
 */
import { Readable } from "node:stream";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  installPublicNetwork,
  loadFileStack,
  PUBLIC,
  type FileStack,
  type PublicNetwork,
} from "./support/public-network.js";
import {
  closedPort,
  startScriptServer,
  writes,
  type ScriptServer,
} from "./support/script-server.js";

const HOST = "files.example.test";
let server: ScriptServer;
let network: PublicNetwork;
let stack: FileStack;
const exporter = new InMemorySpanExporter();

beforeAll(async () => {
  server = await startScriptServer(HOST);
  network = installPublicNetwork(server);
  stack = await loadFileStack();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(async () => {
  network.restore();
  trace.disable();
  await server.close();
});
beforeEach(() => {
  network.reset();
  exporter.reset();
});

const URL_OF = new URL(`https://${HOST}:8443/f.pdf?token=secret#frag`);

/** The spans that ended, once the body has closed (a turn after the stream does). */
async function spans() {
  await new Promise((resolve) => setTimeout(resolve, 30));
  return exporter.getFinishedSpans();
}

async function drained(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("latin1");
}

describe("#1244 a response", () => {
  it("T1 hands the status, the Location and the body; the span has the request's attributes only", async () => {
    server.serve(
      writes(["HTTP/1.1 200 OK\r\nLocation: /elsewhere\r\nContent-Length: 5\r\n\r\nhello"], false),
    );
    const response = await stack.httpsFileTransport(URL_OF, new AbortController().signal);

    expect(response.status).toBe(200);
    expect(response.location).toBe("/elsewhere");
    expect(await drained(response.body)).toBe("hello");
    const [span] = await spans();
    expect(span).toMatchObject({ name: "GET", kind: SpanKind.CLIENT });
    expect(span?.attributes).toEqual({
      "http.request.method": "GET",
      "server.address": HOST,
      "server.port": 8443,
      "url.full": `https://${HOST}:8443/f.pdf`,
      "http.response.status_code": 200,
    });
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("T2 the default port is 443 on the span, and an IPv6 host is without brackets", async () => {
    server.serve(writes(["HTTP/1.1 204 No Content\r\n\r\n"], false));
    const response = await stack.httpsFileTransport(
      new URL(`https://${HOST}/a`),
      new AbortController().signal,
    );
    await drained(response.body);
    const [span] = await spans();
    expect(span?.attributes["server.port"]).toBe(443);
    expect(span?.attributes["url.full"]).toBe(`https://${HOST}/a`);
    expect(span?.attributes["server.address"]).toBe(HOST);
  });

  it("T3 a status of 400 and above ends the span with that status as its error type", async () => {
    server.serve(writes(["HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"], false));
    const response = await stack.httpsFileTransport(URL_OF, new AbortController().signal);
    response.cancel();
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("404");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("T4 a cancelled read closes the connection; the first failure it names is the span's error type", async () => {
    server.serve(writes(["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart"], false));
    const response = await stack.httpsFileTransport(URL_OF, new AbortController().signal);
    response.cancel("a2a.file-too-large");
    response.cancel("another");
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("a2a.file-too-large");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("T5 a read cancelled with no failure (a redirect, a refused status) leaves no error on a status below 400", async () => {
    server.serve(
      writes(["HTTP/1.1 302 Found\r\nLocation: /n\r\nContent-Length: 0\r\n\r\n"], false),
    );
    const response = await stack.httpsFileTransport(URL_OF, new AbortController().signal);
    response.cancel();
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBeUndefined();
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("T6 a body cut by the peer ends the span with the socket's error code", async () => {
    server.serve(writes(["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart"]));
    const response = await stack.httpsFileTransport(URL_OF, new AbortController().signal);
    await expect(drained(response.body)).rejects.toMatchObject({ code: "ECONNRESET" });
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("ECONNRESET");
  });

  it("T7 a body cut by the abort ends the span with ABORT_ERR", async () => {
    const controller = new AbortController();
    server.serve(writes(["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart"], false));
    const response = await stack.httpsFileTransport(URL_OF, controller.signal);
    controller.abort();
    await expect(drained(response.body)).rejects.toMatchObject({ code: "ABORT_ERR" });
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("ABORT_ERR");
  });

  it("T8 a body destroyed by someone else, with no error, is a fetch that failed", async () => {
    server.serve(writes(["HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart"], false));
    const response = await stack.httpsFileTransport(URL_OF, new AbortController().signal);
    expect(response.body).toBeInstanceOf(Readable);
    if (response.body instanceof Readable) response.body.destroy();
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("a2a.file-fetch-failed");
  });

  it("T9 a body to the connection's close (an error's) ends the span with its status, no failure of the body", async () => {
    server.serve(writes(["HTTP/1.1 404 Not Found\r\n\r\nall of it"]));
    const response = await stack.httpsFileTransport(URL_OF, new AbortController().signal);
    expect(await drained(response.body)).toBe("all of it");
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("404");
  });
});

describe("#1244 a request that fails before a response", () => {
  it("F1 a denied IP literal is refused as FileAddressDeniedError, with no connection, the span ended with its name", async () => {
    const failure = await stack
      .httpsFileTransport(new URL("https://10.0.0.1/x"), new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(stack.FileAddressDeniedError);
    expect(failure).toMatchObject({ name: "FileAddressDeniedError" });
    expect(network.seen.netOptions).toEqual([]);
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("FileAddressDeniedError");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("F2 a name that resolves to a denied address, and a peer that is not the answer, are refused the same way", async () => {
    network.answers = ["127.0.0.1"];
    await expect(
      stack.httpsFileTransport(URL_OF, new AbortController().signal),
    ).rejects.toBeInstanceOf(stack.FileAddressDeniedError);
    network.answers = [PUBLIC];
    network.claimed = "10.0.0.9";
    await expect(
      stack.httpsFileTransport(URL_OF, new AbortController().signal),
    ).rejects.toBeInstanceOf(stack.FileAddressDeniedError);
    expect(server.received).toEqual([]);
  });

  it("F3 any other failure is passed on as it is, the span ended with its code", async () => {
    network.routes.set(PUBLIC, await closedPort());
    const failure = await stack
      .httpsFileTransport(URL_OF, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(stack.FileAddressDeniedError);
    expect(failure).toMatchObject({ code: "ECONNREFUSED" });
    const [span] = await spans();
    expect(span?.attributes["error.type"]).toBe("ECONNREFUSED");
  });

  it("F4 an error with no code is typed by its name, and a value that is none by `Error`", async () => {
    expect(stack.errorTypeOf(new RangeError("x"))).toBe("RangeError");
    expect(stack.errorTypeOf("text")).toBe("Error");
    expect(stack.errorTypeOf(Object.assign(new Error("x"), { code: "E1" }))).toBe("E1");
    expect(stack.errorTypeOf(Object.assign(new Error("x"), { code: 5 }))).toBe("Error");
  });
});
