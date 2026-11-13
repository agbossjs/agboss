/**
 * #916 D2 (the re-acceptance of #932): the two guards below the guarded lookup bite. Each case is a
 * child process that patches the HTTP stack below `https.request` before the core is loaded — so
 * the fetch connects with no guarded lookup, to a loopback "file server" that counts what it
 * receives. Only the request's own guards can stop it:
 *  - the peer check (`verifyPeerOf`): a socket to an address that is denied, or that the lookup
 *    did not answer, is destroyed at the TCP connect, before TLS starts — the target receives no
 *    byte (no ClientHello, which carries the host name), whatever the patch;
 *  - the agent check: a request that does not use the file agent is destroyed before it connects
 *    at all (the target sees no connection) — the first guard for a replaced `ClientRequest`.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** One fetch of `localhost` in a child process that applies the patch `mode` names. */
async function fetchedUnder(mode: string): Promise<Record<string, unknown>> {
  const url = `https://localhost:${String(network.targetPort)}/document.pdf`;
  const run = await runNode(["--import", "tsx", CHILD, url, mode, network.proxyUrl], {
    env: { ...process.env, NO_PROXY: "", no_proxy: "" },
  });
  if (run.status !== 0) throw new Error(`the child failed:\n${run.stderr}`);
  return JSON.parse(run.stdout.trim()) as Record<string, unknown>;
}

const REFUSED = { outcome: "a2a.file-address-denied", isProxying: true };

describe("#916 D2: the peer check stops a fetch that skipped the guarded lookup", () => {
  it.each([
    ["https.Agent.prototype.createConnection drops the lookup", "patch-create-connection"],
    [
      "https.Agent.prototype.addRequest hands the request to an unguarded agent",
      "patch-add-request",
    ],
    ["tls.connect drops the lookup", "patch-tls-connect"],
    ["net.Socket.prototype.connect drops the lookup", "patch-socket-connect"],
    ["a replaced http.ClientRequest swaps the agent", "patch-client-request"],
  ])(
    "D2.1 %s: refused a2a.file-address-denied, no byte (no ClientHello) reaches the target",
    async (_patch, mode) => {
      network.reset();

      const fetched = await fetchedUnder(mode);

      expect(fetched).toEqual(REFUSED);
      expect(network.targetBytes()).toBe(0);
      expect(network.tunnels).toEqual([]);
    },
    30_000,
  );
});

describe("#916 D2: the agent check stops a request that is not on the file agent", () => {
  it("D2.2 a replaced ClientRequest that swaps the agent: refused before it connects at all", async () => {
    network.reset();

    const fetched = await fetchedUnder("patch-client-request");

    expect(fetched).toEqual(REFUSED);
    expect(network.targetConnections()).toBe(0);
    expect(network.targetBytes()).toBe(0);
  }, 30_000);
});
