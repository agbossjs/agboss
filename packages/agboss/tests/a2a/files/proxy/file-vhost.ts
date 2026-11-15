// #1021 / #1022: a local TLS server for one host name (a self-signed certificate), recording every
// HTTP request it receives and every TCP connection made to it. A child process trusts it through
// `NODE_EXTRA_CA_CERTS` (`trust`). Paths (#1139): `/big` sends 100 KB, `/slow` a status line then
// one body byte per 100 ms, `/cut` a status line and part of the body, then a reset; any other
// path a small PDF.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    response.statusCode = 200;
    response.setHeader("content-type", "application/pdf");
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
