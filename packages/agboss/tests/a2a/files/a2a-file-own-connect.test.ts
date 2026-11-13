/**
 * #916 D3 (the re-acceptance of #932): the file fetch makes its own connection and takes nothing
 * from a patchable `https.Agent`. Each case is a child process that replaces `https.Agent` — or a
 * piece of `net` — before the core loads, against a real tunnelling proxy and a loopback target
 * that is silent and counts what it receives: no tunnel (`CONNECT`), no byte at the target, a
 * refusal `a2a.file-address-denied`, and a fetch that settles. The fetch's deadline and the
 * unit of the peer check are proved in-process.
 */
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileTransport } from "../../../src/a2a/files/a2a-file-transport.js";
import { fetchedFile } from "../../../src/a2a/files/a2a-file-fetch.js";
import { connectionTo, rawSocketTo } from "../../../src/a2a/files/a2a-file-connect.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { kilobytes, seconds } from "../../../src/units/index.js";
import { runNode } from "../../helpers/process.js";
import { startNetwork, type Network } from "./proxy/servers.js";

const CHILD = fileURLToPath(new URL("./proxy/file-fetch-process.ts", import.meta.url));

let network: Network;
beforeAll(async () => {
  network = await startNetwork();
});
afterAll(async () => {
  await network.close();
});

/** One fetch of `localhost` in a child process (timeout 1500 ms) that applies `mode`. */
async function fetchedUnder(mode: string): Promise<unknown> {
  const url = `https://localhost:${String(network.targetPort)}/document.pdf`;
  const run = await runNode(["--import", "tsx", CHILD, url, mode, network.proxyUrl, "1500"], {
    env: { ...process.env, NO_PROXY: "", no_proxy: "" },
  });
  if (run.status !== 0) throw new Error(`the child failed:\n${run.stderr}`);
  return JSON.parse(run.stdout.trim());
}

describe("#916 D3: a replaced https.Agent class does not reach the file fetch", () => {
  it.each([
    ["a subclass whose agents tunnel through proxyEnv", "class-proxy-env"],
    ["a class whose constructor returns a native agent with proxyEnv", "class-native-proxy"],
  ])(
    "D3.1 https.Agent replaced by %s: refused, no CONNECT, no byte at the target, and it settles",
    async (_class, mode) => {
      network.reset();

      const fetched = await fetchedUnder(mode);

      expect(fetched).toEqual({ outcome: "a2a.file-address-denied", isProxying: true });
      expect(network.tunnels).toEqual([]);
      expect(network.targetConnections()).toBe(0);
      expect(network.targetBytes()).toBe(0);
    },
    30_000,
  );

  it("D3.2 a patched net.connect that goes to the target anyway: the peer check refuses it, 0 bytes", async () => {
    network.reset();

    const fetched = await fetchedUnder("net-redirect");

    expect(fetched).toEqual({ outcome: "a2a.file-address-denied", isProxying: true });
    // the TCP connection is made (net is patched, and nothing probes it); it is destroyed at
    // connect, before a ClientHello or a byte of the request
    expect(network.targetConnections()).toBe(1);
    expect(network.targetBytes()).toBe(0);
  }, 30_000);
});

describe("#916 D3: the deadline settles the fetch by itself", () => {
  it("D3.3 a transport that never answers and ignores the signal: refused in time at the timeout", async () => {
    const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
    const silent: FileTransport = () => new Promise(() => undefined);
    const fetched = fetchedFile({
      url: "https://files.example/a.pdf",
      allowedOrigins: ["https://files.example"],
      maxBytes: kilobytes(64),
      transport: silent,
      clock,
      timeout: seconds(10),
      signal: new AbortController().signal,
    }).then(
      () => "fetched",
      (error: unknown) =>
        String(Reflect.get(Object(Reflect.get(Object(error), "metadata")), "code")),
    );

    await clock.advance(seconds(10));

    await expect(fetched).resolves.toBe("a2a.file-fetch-failed");
  });

  it("D3.4 the request's end settles it as well, whatever the transport does", async () => {
    const ended = new AbortController();
    const silent: FileTransport = () => new Promise(() => undefined);
    const fetched = fetchedFile({
      url: "https://files.example/a.pdf",
      allowedOrigins: ["https://files.example"],
      maxBytes: kilobytes(64),
      transport: silent,
      clock: new VirtualClock(new Date("2026-01-05T09:00:00.000Z")),
      timeout: seconds(10),
      signal: ended.signal,
    });

    ended.abort();

    await expect(fetched).rejects.toMatchObject({ metadata: { code: "a2a.file-fetch-failed" } });
  });
});

describe("#916 D3: the raw socket's peer is checked before anything is sent", () => {
  it("D3.5 a TCP connection to a denied address is destroyed at connect: 0 bytes at the target", async () => {
    let bytes = 0;
    const open = new Set<Socket>();
    const server = createServer((socket) => {
      open.add(socket);
      socket.on("data", (chunk: Buffer) => (bytes += chunk.length));
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const connected = rawSocketTo("127.0.0.1", port, new AbortController().signal);

    await expect(connected).rejects.toMatchObject({ code: "A2A_FILE_ADDRESS_DENIED" });
    expect(bytes).toBe(0);
    for (const socket of open) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it("D3.6 an abort that already fired opens no socket: 0 connections at the target", async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const aborted = AbortSignal.abort();

    const connected = rawSocketTo("127.0.0.1", port, aborted);

    await expect(connected).rejects.toThrow("aborted");
    expect(connections).toBe(0);
    await new Promise((resolve) => server.close(resolve));
  });

  it("D3.7 a name of several addresses after an abort: rejected at once, the next address is not tried", async () => {
    const aborted = AbortSignal.abort();
    const addresses = [93, 94, 95].map((last) => ({
      address: `93.184.216.${String(last)}`,
      family: 4,
    }));
    let asked = 0;

    const connected = connectionTo(
      new URL("https://files.example/a.pdf"),
      aborted,
      (_name, done) => {
        asked += 1;
        done(null, addresses);
      },
    );

    await expect(connected).rejects.toThrow("aborted");
    expect(asked).toBeLessThanOrEqual(1);
  });

  it("D3.7b an abort wins over the address loop's next step: an aborted signal ends it before any address is looked at", async () => {
    // an IP literal has no resolver to race: the loop's own abort check is all there is, and
    // without it the denied address would be judged (and answered) after the abort
    const connected = connectionTo(new URL("https://10.0.0.1/a.pdf"), AbortSignal.abort());

    await expect(connected).rejects.toThrow("aborted");
  });

  it("D3.8 a resolver that never answers cannot hold the connection past an abort", async () => {
    const ended = new AbortController();

    const connected = connectionTo(
      new URL("https://files.example/a.pdf"),
      ended.signal,
      () => undefined,
    );
    ended.abort();

    await expect(connected).rejects.toThrow("aborted");
  });
});
