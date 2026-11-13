/**
 * #916 D2 and D3 (the re-acceptances of #932): a patch of the HTTP stack below `https.request`,
 * applied before the core is loaded, does not get a connection to a denied address. Each case is a
 * child process with the patch, against a loopback "file server" that counts what it receives. The
 * file fetch has no agent and makes its own connection: it probes that `net.connect`,
 * `tls.connect` and `ClientRequest` are Node's own (a patched one is refused, nothing connected)
 * and it resolves the name with the guarded resolver, connecting to an address only after the
 * resolver allowed it. So for every patch below the target sees no connection at all and no byte —
 * whatever the speed of the resolver. (The check of the raw socket's peer, which would stop a
 * patch that evades the probe, is a unit test: a2a-file-own-connect.test.ts D3.5.)
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

describe("#916 D2: a patch below https.request gets no connection to a denied address", () => {
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
    "D2.1 %s: refused a2a.file-address-denied, no connection and no byte reach the target",
    async (_patch, mode) => {
      network.reset();

      const fetched = await fetchedUnder(mode);

      expect(fetched).toEqual(REFUSED);
      expect(network.targetConnections()).toBe(0);
      expect(network.targetBytes()).toBe(0);
      expect(network.tunnels).toEqual([]);
    },
    30_000,
  );
});
