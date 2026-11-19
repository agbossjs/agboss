// #1021 / #1022: a local TLS server for one host name (a self-signed certificate), recording every
// HTTP request it receives and every TCP connection made to it. A child process trusts it through
// `NODE_EXTRA_CA_CERTS` (`trust`). Paths (#1139): `/big` sends 100 KB, `/slow` a status line then
// one body byte per 100 ms, `/cut` a status line and part of the body, then a reset,
// `/partial` a 206 and `/empty` a 204 (#1021: a refused status), `/ranged` a 200 that carries a
// `Content-Range`, `/redirect?to=<url>` a 302 to that url, `/garbage` a head no HTTP parser takes (#1138); any
// other path a small PDF.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface Vhost {
  readonly port: number;
  /** The `url` of every HTTP request that reached the server. */
  readonly requests: string[];
  /** The headers of every HTTP request, by name (lower case), in order. */
  readonly headers: Record<string, string | string[] | undefined>[];
  /** TCP connections the server accepted (a TLS handshake or not). */
  readonly connections: () => number;
  readonly reset: () => void;
  /** The PEM file a client trusts. */
  readonly trust: string;
  readonly close: () => Promise<void>;
}

const REDIRECT = "/redirect?to=";
/** A path's whole answer: its status, its `Content-Range` and its body (#1021). */
const ANSWERS: Record<string, readonly [number, string | undefined, string]> = {
  "/partial": [206, "bytes 0-4/100", "%PDF-"],
  "/empty": [204, undefined, ""],
  "/ranged": [200, "bytes 0-14/100", "%PDF-1.4 a file"],
};

/** Whether `url` has a whole answer of its own (`ANSWERS`): given. */
function answeredAlone(url: string | undefined, response: ServerResponse): boolean {
  const answer = url === undefined ? undefined : ANSWERS[url];
  if (answer === undefined) return false;
  const [status, range, body] = answer;
  response.statusCode = status;
  if (range !== undefined) response.setHeader("content-range", range);
  response.end(body);
  return true;
}

export async function startVhost(host: string): Promise<Vhost> {
  const directory = await mkdtemp(join(tmpdir(), "agboss-vhost-"));
  const key = join(directory, "host.key");
  const trust = join(directory, "host.crt");
  await promisify(execFile)("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", key, "-out", trust, "-days", "2", "-subj", `/CN=${host}`],
    ...["-addext", `subjectAltName=DNS:${host}`],
  ]);
  const requests: string[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  let connections = 0;
  const server: Server = createServer({ key: await readFile(key), cert: await readFile(trust) });
  server.on("connection", () => {
    connections += 1;
  });
  server.on("request", (request, response) => {
    requests.push(request.url ?? "");
    headers.push({ ...request.headers });
    response.setHeader("content-type", "application/pdf");
    if (answeredAlone(request.url, response)) return;
    response.statusCode = 200;
    if (request.url === "/big") response.end(Buffer.alloc(100 * 1024, 0x41));
    else if (request.url === "/slow") {
      response.flushHeaders();
      const trickle = setInterval(() => response.write("a"), 100);
      response.on("close", () => {
        clearInterval(trickle);
      });
    } else if (request.url === "/cut") {
      response.write("%PDF-1.4 part");
      setTimeout(() => {
        request.socket.destroy();
      }, 50);
    } else if (request.url === "/garbage") {
      request.socket.end("HTTP/1.1 200 OK\r\nno colon here\r\n\r\n");
    } else if (request.url?.startsWith(REDIRECT) === true) {
      response.statusCode = 302;
      response.setHeader("location", decodeURIComponent(request.url.slice(REDIRECT.length)));
      response.end();
    } else response.end("%PDF-1.4 a file");
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    requests,
    headers,
    connections: () => connections,
    reset: () => {
      requests.length = 0;
      headers.length = 0;
      connections = 0;
    },
    trust,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
