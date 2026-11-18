// #1244 — a raw local TLS server that writes exactly the bytes a test's script says (cut in pieces,
// slowly, or not at all), recording each request it receives and each TCP connection it accepts.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { promisify } from "node:util";

/** What a script does with a connection once its request head is in. */
export type Script = (socket: TLSSocket, request: string) => void;

export interface ScriptServer {
  readonly host: string;
  readonly port: number;
  /** The certificate a client trusts (self-signed for `host`). */
  readonly ca: Buffer;
  /** Every request head received, in order. */
  readonly received: string[];
  /** TLS connections accepted. */
  readonly connections: () => number;
  /** What the next connections do. */
  readonly serve: (script: Script) => void;
  readonly close: () => Promise<void>;
}

/** Writes `parts` one after another, a turn of the loop apart, then ends the connection (or not). */
export const writes =
  (parts: readonly (string | Buffer)[], end = true): Script =>
  (socket) => {
    const next = (index: number): void => {
      const part = parts[index];
      if (part === undefined) {
        if (end) socket.end();
        return;
      }
      socket.write(typeof part === "string" ? Buffer.from(part, "latin1") : part, () => {
        setTimeout(() => {
          next(index + 1);
        }, 2);
      });
    };
    next(0);
  };

export async function startScriptServer(host: string): Promise<ScriptServer> {
  const directory = await mkdtemp(join(tmpdir(), "agboss-script-server-"));
  const key = join(directory, "host.key");
  const cert = join(directory, "host.crt");
  await promisify(execFile)("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${host}`],
    ...["-addext", `subjectAltName=DNS:${host}`],
  ]);
  const ca = await readFile(cert);
  const received: string[] = [];
  let script: Script = () => undefined;
  let connections = 0;
  const open = new Set<TLSSocket>();
  const server: Server = createServer({ key: await readFile(key), cert: ca }, (socket) => {
    connections += 1;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let request = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      request += chunk.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      received.push(request);
      script(socket, request);
    });
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    host,
    port: typeof address === "object" && address !== null ? address.port : 0,
    ca,
    received,
    connections: () => connections,
    serve: (next) => {
      script = next;
    },
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A local port nothing listens on (a connection to it is refused). */
export async function closedPort(): Promise<number> {
  const { createServer: plain } = await import("node:net");
  const holder = plain();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const address = holder.address();
  await new Promise((resolve) => holder.close(resolve));
  return typeof address === "object" && address !== null ? address.port : 0;
}
