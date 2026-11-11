// #916 item 1: one fetch of a file by url in a process of its own, run by
// a2a-file-proxy.test.ts with an environment proxy set at its start (NODE_USE_ENV_PROXY=1,
// HTTPS_PROXY, or --use-env-proxy) — or, with "global-agent", with https.globalAgent replaced by a
// proxying agent in code. Prints one JSON line: the fetch's outcome, and whether the global agent
// proxies (so the test proves the proxy was live, never a vacuous pass).
import https from "node:https";
import { fetchedFile } from "../../../../src/a2a/files/a2a-file-fetch.js";
import { httpsFileTransport } from "../../../../src/a2a/files/a2a-file-transport.js";
import { systemClock } from "../../../../src/infrastructure/clock.js";
import { kilobytes, seconds } from "../../../../src/units/index.js";

const [url = "", mode = "env", proxy = ""] = process.argv.slice(2);

if (mode === "global-agent") {
  // Node ≥ 24: an agent that tunnels through `proxyEnv`'s proxy
  https.globalAgent = new https.Agent({ proxyEnv: { HTTPS_PROXY: proxy } } as https.AgentOptions);
}

const isProxying = Reflect.get(https.globalAgent.options, "proxyEnv") !== undefined;

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
