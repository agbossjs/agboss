// #916: one fetch of a file by url in a process of its own, run by a2a-file-proxy.test.ts and
// a2a-file-global-agent.test.ts with a proxy or a patch of the HTTP client in place at its start
// (NODE_USE_ENV_PROXY=1, HTTPS_PROXY, `--use-env-proxy`, `-r global-agent/bootstrap`) or set by
// `mode` in code: "global-agent" (https.globalAgent replaced by a proxying agent), "ga-before" /
// "ga-after" / "ga-after-sync" (`global-agent`'s `bootstrap()` before the core is loaded, after it,
// and after it with `syncBuiltinESMExports()`), "patch" (a hand-written `https.request` /
// `http.request` patch that forces an agent without the guard). Prints one JSON line: the fetch's
// outcome, and whether something replaced the HTTP client (so a test never passes vacuously). No
// top-level await: a2a-file-global-agent.test.ts bundles this file to CommonJS.
import type * as HttpModule from "node:http";
import type * as HttpsModule from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";

// `require`, not `import`: an ESM import of `node:https` would fix the named exports the core is
// later loaded with before `bootstrap()` patched them
const load = createRequire(import.meta.url);
const http = load("node:http") as typeof HttpModule;
const https = load("node:https") as typeof HttpsModule;

const [url = "", mode = "env", proxy = ""] = process.argv.slice(2);

const bootstrapped = (): void => {
  // global-agent ships no types
  (load("global-agent") as { bootstrap: () => void }).bootstrap();
};

/** An agent that skips the guard: what a patch that "forces an agent" installs. */
const unguarded = new https.Agent({ keepAlive: false });
const original = { https: https.request, http: http.request };

type Request = typeof https.request;

function patchedRequests(): void {
  const force =
    (request: Request): Request =>
    (first: unknown, second: unknown, ...rest: unknown[]) => {
      const options =
        typeof second === "object" && second !== null ? { ...second, agent: unguarded } : second;
      return Reflect.apply(request, https, [first, options, ...rest]) as HttpModule.ClientRequest;
    };
  https.request = force(original.https);
  http.request = force(original.http);
  syncBuiltinESMExports();
}

async function main(): Promise<void> {
  if (mode === "global-agent") {
    // Node >= 24: an agent that tunnels through `proxyEnv`'s proxy
    https.globalAgent = new https.Agent({
      proxyEnv: { HTTPS_PROXY: proxy },
    } as HttpsModule.AgentOptions);
  }
  if (mode === "ga-before") bootstrapped();
  if (mode === "patch") patchedRequests();

  const [{ fetchedFile }, { httpsFileTransport }, { systemClock }, { kilobytes, seconds }] =
    await Promise.all([
      import("../../../../src/a2a/files/a2a-file-fetch.js"),
      import("../../../../src/a2a/files/a2a-file-transport.js"),
      import("../../../../src/infrastructure/clock.js"),
      import("../../../../src/units/index.js"),
    ]);
  if (mode === "ga-after") bootstrapped();
  if (mode === "ga-after-sync") {
    bootstrapped();
    syncBuiltinESMExports();
  }

  const isProxying =
    Reflect.get(Object(Reflect.get(https.globalAgent, "options")), "proxyEnv") !== undefined ||
    Reflect.get(globalThis, "GLOBAL_AGENT") !== undefined ||
    https.request !== original.https;

  const outcome = await fetchedFile({
    url,
    allowedOrigins: [new URL(url).origin],
    maxBytes: kilobytes(64),
    transport: httpsFileTransport,
    clock: systemClock,
    timeout: seconds(5),
    signal: new AbortController().signal,
  }).then(
    () => "fetched",
    (error: unknown) => String(Reflect.get(Object(Reflect.get(Object(error), "metadata")), "code")),
  );

  process.stdout.write(`${JSON.stringify({ outcome, isProxying })}\n`);
}

void main();
