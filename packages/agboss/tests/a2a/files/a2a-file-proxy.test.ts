/**
 * #916 item 1 (AC1): a file by `url` is never fetched through a proxy. Behind an environment proxy
 * — `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY`, `--use-env-proxy`, or `https.globalAgent` replaced
 * by a proxying agent — the guarded lookup still decides: a name that resolves to a loopback address
 * is refused `a2a.file-address-denied`, the proxy is never asked to tunnel to it and the target
 * never sees a connection. Each case runs in a process of its own (the flag is read at its start)
 * against a real local CONNECT proxy, which tunnels for real — so a fetch that went through it would
 * reach the target.
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

interface ChildOutcome {
  readonly outcome: string;
  readonly isProxying: boolean;
}

/** One fetch of `url` in a child process behind the proxy, set as `mode` says. */
async function fetchedBehindProxy(url: string, mode: string): Promise<ChildOutcome> {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: "", no_proxy: "" };
  const flags: string[] = [];
  if (mode === "env")
    Object.assign(environment, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: network.proxyUrl });
  if (mode === "flag") {
    flags.push("--use-env-proxy");
    Object.assign(environment, { HTTPS_PROXY: network.proxyUrl });
  }
  const run = await runNode([...flags, "--import", "tsx", CHILD, url, mode, network.proxyUrl], {
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
      network.reset();
      const url = `https://localhost:${String(network.targetPort)}/document.pdf`;

      const fetched = await fetchedBehindProxy(url, mode);

      expect(fetched).toEqual({ outcome: "a2a.file-address-denied", isProxying: true });
      expect(network.tunnels).toEqual([]);
      expect(network.targetConnections()).toBe(0);
    },
    30_000,
  );
});
