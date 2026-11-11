/**
 * #916 item 1 (AC1): a file by `url` is never fetched through a proxy. Behind an environment proxy
 * — `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY`, `--use-env-proxy`, or `https.globalAgent` replaced
 * by a proxying agent — the guarded lookup still decides: a name that resolves to a loopback address
 * is refused `a2a.file-address-denied`, the proxy is never asked to tunnel to it and the target
 * never sees a connection. Each case runs in a process of its own (the flag is read at its start)
 * against a real local CONNECT proxy, which tunnels for real — so a fetch that went through it would
 * reach the target.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNode } from "../../helpers/process.js";

const CHILD = fileURLToPath(new URL("./proxy/file-fetch-process.ts", import.meta.url));

/** Where the CONNECT proxy was asked to tunnel to, in order. */
const tunnels: string[] = [];
/** Connections the target (a loopback "file server") saw. */
let targetConnections = 0;

const target = createTcpServer((socket) => {
  targetConnections += 1;
  socket.destroy();
});

const proxy: Server = createHttpServer().on("connect", (request, socket) => {
  const to = request.url ?? "";
  tunnels.push(to);
  const [host = "", port = "0"] = to.split(/:(?=\d+$)/u);
  const upstream = connect(Number(port), host, () => {
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

const portOf = (server: { address: () => unknown }): number =>
  (server.address() as AddressInfo).port;
const listening = (server: Server | ReturnType<typeof createTcpServer>) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

beforeAll(async () => {
  await Promise.all([listening(target), listening(proxy)]);
});

afterAll(async () => {
  await Promise.all(
    [target, proxy].map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

interface ChildOutcome {
  readonly outcome: string;
  readonly isProxying: boolean;
}

/** One fetch of `url` in a child process behind the proxy, set as `mode` says. */
async function fetchedBehindProxy(url: string, mode: string): Promise<ChildOutcome> {
  const proxyUrl = `http://127.0.0.1:${String(portOf(proxy))}`;
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: "", no_proxy: "" };
  const flags: string[] = [];
  if (mode === "env")
    Object.assign(environment, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxyUrl });
  if (mode === "flag") {
    flags.push("--use-env-proxy");
    Object.assign(environment, { HTTPS_PROXY: proxyUrl });
  }
  const run = await runNode([...flags, "--import", "tsx", CHILD, url, mode, proxyUrl], {
    env: environment,
  });
  if (run.status !== 0) throw new Error(`the child failed:\n${run.stderr}`);
  return JSON.parse(run.stdout.trim()) as ChildOutcome;
}

describe("#916 item 1 AC1: no file fetch goes through a proxy", () => {
  it.each([
    ["NODE_USE_ENV_PROXY=1 and HTTPS_PROXY", "env"],
    ["--use-env-proxy and HTTPS_PROXY", "flag"],
    ["https.globalAgent replaced by a proxying agent", "global-agent"],
  ])(
    "AC1 %s: a name resolving to loopback is refused a2a.file-address-denied, nothing tunnelled",
    async (_setting, mode) => {
      tunnels.length = 0;
      targetConnections = 0;
      const url = `https://localhost:${String(portOf(target))}/document.pdf`;

      const fetched = await fetchedBehindProxy(url, mode);

      expect(fetched).toEqual({ outcome: "a2a.file-address-denied", isProxying: true });
      expect(tunnels).toEqual([]);
      expect(targetConnections).toBe(0);
    },
    30_000,
  );
});
