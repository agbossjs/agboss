/**
 * #916 (the fix after the spec review of #1010): the TLS handshake of a file fetch carries the
 * host as SNI (a TLS socket made on an existing socket has none unless `servername` is given), an
 * APM's pass-through wrappers over `net`, `tls` and `ClientRequest` do not break the fetch, and a
 * request that is not the module's own (an agent) or a peer that is not the answered address is
 * refused with no byte sent. Each case is a child process on a simulated public network
 * (proxy/file-tls-process.ts: the name resolves to a public address, the socket is really made to
 * a local server and reports that address as its remote one).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecureContext, type SecureContext } from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNode } from "../../helpers/process.js";
import { startNetwork, type Network } from "./proxy/servers.js";

const CHILD = fileURLToPath(new URL("./proxy/file-tls-process.ts", import.meta.url));
const HOST = "files.example.test";
const OTHER = "other.example.test";
const IP = "93.184.216.34";
const run = promisify(execFile);

let directory: string;
let network: Network;
let server: Server;
let port: number;
const names: (string | undefined)[] = [];
const requests: (string | undefined)[] = [];

/** A self-signed certificate valid for `alt` (a `DNS:` or `IP:` subjectAltName). */
async function certificate(name: string, alt: string): Promise<SecureContext> {
  const key = join(directory, `${name}.key`);
  const cert = join(directory, `${name}.crt`);
  await run("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${name}`],
    ...["-addext", `subjectAltName=${alt}`],
  ]);
  return createSecureContext({ key: await readFile(key), cert: await readFile(cert) });
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "agboss-sni-"));
  const forHost = await certificate("host", `DNS:${HOST}`);
  const forDefault = await certificate("default", `DNS:${OTHER},IP:${IP}`);
  await run("sh", ["-c", `cat host.crt default.crt > trust.pem`], { cwd: directory });
  // a name-based virtual host: the certificate is chosen by the SNI of the ClientHello
  server = createServer({
    SNICallback: (name, done) => {
      names.push(name);
      done(null, name === HOST ? forHost : forDefault);
    },
    ...{
      key: await readFile(join(directory, "default.key")),
      cert: await readFile(join(directory, "default.crt")),
    },
  });
  server.on("request", (request, response) => {
    requests.push(request.url);
    response.statusCode = 200;
    response.setHeader("content-type", "application/pdf");
    response.end("%PDF-1.4 a file");
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  network = await startNetwork();
});
afterAll(async () => {
  await network.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

async function fetchedUnder(
  url: string,
  mode: string,
  target: number,
  claimed = "",
): Promise<{ outcome: string; calls: Record<string, number> }> {
  const result = await runNode(["--import", "tsx", CHILD, url, mode, String(target), claimed], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, "trust.pem") },
  });
  if (result.status !== 0) throw new Error(`the child failed:\n${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as { outcome: string; calls: Record<string, number> };
}

describe("#916 SNI: the handshake of a file fetch names the host", () => {
  it("S1 a virtual host that serves by SNI is fetched, and the ClientHello's SNI is the host", async () => {
    names.length = 0;

    const fetched = await fetchedUnder(`https://${HOST}:${String(port)}/a.pdf`, "plain", port);

    expect(fetched.outcome).toBe("fetched");
    expect(names).toEqual([HOST]);
  }, 30_000);

  it("S2 an IP-literal url sends no SNI and does not throw", async () => {
    names.length = 0;

    const fetched = await fetchedUnder(`https://${IP}:${String(port)}/a.pdf`, "plain", port);

    expect(fetched.outcome).toBe("fetched");
    expect(names).toEqual([]);
  }, 30_000);
});

describe("#916 APM: pass-through wrappers do not break a legitimate fetch", () => {
  it("S3 net.connect, tls.connect and ClientRequest wrapped as an APM does: the fetch succeeds", async () => {
    const fetched = await fetchedUnder(`https://${HOST}:${String(port)}/a.pdf`, "otel", port);

    expect(fetched.outcome).toBe("fetched");
    expect(fetched.calls.net).toBeGreaterThan(0);
    expect(fetched.calls.tls).toBeGreaterThan(0);
    expect(fetched.calls.request).toBeGreaterThan(0);
  }, 30_000);

  it("S4 a net.connect that reaches another public-looking address is refused, 0 bytes sent", async () => {
    network.reset();

    const fetched = await fetchedUnder(
      `https://${HOST}:${String(network.targetPort)}/a.pdf`,
      "plain",
      network.targetPort,
      "93.184.216.99",
    );

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(network.targetBytes()).toBe(0);
  }, 30_000);

  it("S5 a replaced ClientRequest that gives the request an agent is refused: no request reaches the server", async () => {
    requests.length = 0;

    const fetched = await fetchedUnder(
      `https://${HOST}:${String(port)}/a.pdf`,
      "refuse-agent",
      port,
    );

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(requests).toEqual([]);
  }, 30_000);
});
