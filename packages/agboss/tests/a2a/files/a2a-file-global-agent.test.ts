/**
 * #916 D1 (the acceptance's rejection of #918): a library that patches `https.request` and swaps in
 * its own agent — `global-agent`, the common Node proxy library, by default — must not reach a file
 * fetch around the guard. Every setup that replaced the HTTP client — `-r global-agent/bootstrap`,
 * `--import global-agent/bootstrap.js`, `bootstrap()` before the core is loaded, after it, after it
 * with `syncBuiltinESMExports()`, a CommonJS bundle of the core, and a hand-written patch of
 * `https.request` / `http.request` that forces an agent — with a proxy configured and without one
 * (a direct connection the patched agent makes without the guarded lookup): a name that resolves to
 * loopback is refused `a2a.file-address-denied`, the proxy is never asked to tunnel and the target
 * never sees a connection. Real `global-agent`, a child process per case, a real tunnelling proxy.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runNode } from "../../helpers/process.js";
import { startNetwork, type Network } from "./proxy/servers.js";

const CHILD = fileURLToPath(new URL("./proxy/file-fetch-process.ts", import.meta.url));
const requireHere = createRequire(import.meta.url);
const BOOTSTRAP = requireHere.resolve("global-agent/bootstrap");
const BOOTSTRAP_ESM = fileURLToPath(
  new URL("../../../../../node_modules/global-agent/bootstrap.js", import.meta.url),
);

let network: Network;
let bundleDir: string;
let bundle: string;

beforeAll(async () => {
  network = await startNetwork();
  bundleDir = await mkdtemp(join(tmpdir(), "agboss-916-"));
  bundle = join(bundleDir, "file-fetch.cjs");
  await build({
    entryPoints: [CHILD],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    define: { "import.meta.url": "importMetaUrl" },
    banner: { js: 'const importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
    target: "es2022", // lowers the standard decorators Node does not run yet
    tsconfig: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
    logLevel: "silent",
  });
}, 60_000);

afterAll(async () => {
  await network.close();
  await rm(bundleDir, { recursive: true, force: true });
});

interface Setup {
  readonly label: string;
  readonly mode: string;
  /** Node's own flags, before the child. */
  readonly flags: readonly string[];
  /** The child's script: the TypeScript source (through tsx), or the CommonJS bundle. */
  readonly script: () => readonly string[];
}

const source = (): readonly string[] => ["--import", "tsx", CHILD];
const SETUPS: readonly Setup[] = [
  { label: "-r global-agent/bootstrap", mode: "plain", flags: ["-r", BOOTSTRAP], script: source },
  {
    label: "--import global-agent/bootstrap.js",
    mode: "plain",
    flags: ["--import", BOOTSTRAP_ESM],
    script: source,
  },
  { label: "bootstrap() before the core is loaded", mode: "ga-before", flags: [], script: source },
  { label: "bootstrap() after the core is loaded", mode: "ga-after", flags: [], script: source },
  {
    label: "bootstrap() after it, then syncBuiltinESMExports()",
    mode: "ga-after-sync",
    flags: [],
    script: source,
  },
  {
    label: "a CommonJS bundle of the core under -r global-agent/bootstrap",
    mode: "plain",
    flags: ["-r", BOOTSTRAP],
    script: () => [bundle],
  },
  {
    label: "a hand-written https.request patch forcing an agent",
    mode: "patch",
    flags: [],
    script: source,
  },
];

async function fetchedWith(setup: Setup, proxied: boolean): Promise<Record<string, unknown>> {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: "", no_proxy: "" };
  if (proxied)
    Object.assign(environment, {
      GLOBAL_AGENT_HTTPS_PROXY: network.proxyUrl,
      GLOBAL_AGENT_HTTP_PROXY: network.proxyUrl,
    });
  const url = `https://localhost:${String(network.targetPort)}/document.pdf`;
  const run = await runNode(
    [...setup.flags, ...setup.script(), url, setup.mode, network.proxyUrl],
    {
      env: environment,
    },
  );
  if (run.status !== 0) throw new Error(`the child failed:\n${run.stderr}`);
  return JSON.parse(run.stdout.trim()) as Record<string, unknown>;
}

describe("#916 D1: no patch of the HTTP client reaches a file fetch around the guard", () => {
  for (const setup of SETUPS)
    for (const proxied of [true, false])
      it(`D1 ${setup.label}, ${proxied ? "with a proxy" : "no proxy (direct)"}: refused a2a.file-address-denied, no tunnel, no connection`, async () => {
        network.reset();

        const fetched = await fetchedWith(setup, proxied);

        expect(fetched).toEqual({ outcome: "a2a.file-address-denied", isProxying: true });
        expect(network.tunnels).toEqual([]);
        expect(network.targetConnections()).toBe(0);
      }, 30_000);
});
