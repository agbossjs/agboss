/**
 * #916 D2 and D3 (the re-acceptances of #932): a patch of the HTTP stack below `https.request`,
 * applied before the core is loaded, does not get a connection to a denied address. Each case is a
 * child process with the patch, against a loopback "file server" that counts what it receives. The
 * file fetch has no agent and makes its own connection, in this order: the name is resolved with the
 * guarded resolver (`localhost` is a denied address: nothing is connected, no request is built),
 * a raw socket is connected only to an allowed answer, its peer is checked, and only then TLS and
 * the request. So for every patch below the target sees no connection and no byte. It does not
 * probe whether `net`, `tls` or `ClientRequest` is patched (APM agents wrap them: a2a-file-sni.test.ts);
 * a patch that redirects the connection is stopped by the peer check (a2a-file-own-connect.test.ts
 * D3.2, D3.5, a2a-file-sni.test.ts S4).
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
    "D2.1 %s: refused a2a.file-address-denied at the guarded lookup, no connection and no byte reach the target",
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
