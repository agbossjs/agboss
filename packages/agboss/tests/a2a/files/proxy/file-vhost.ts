// #1021 / #1022: a local TLS server for one host name (a self-signed certificate), recording every
// HTTP request it receives. A child process trusts it through `NODE_EXTRA_CA_CERTS` (`trust`).
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
  const server: Server = createServer({ key: await readFile(key), cert: await readFile(trust) });
  server.on("request", (request, response) => {
    requests.push(request.url ?? "");
    response.statusCode = 200;
    response.setHeader("content-type", "application/pdf");
    response.end("%PDF-1.4 a file");
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    requests,
    trust,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
