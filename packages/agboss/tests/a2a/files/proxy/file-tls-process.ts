// #916: one fetch of a file in a process of its own, over a simulated public network: the name
// resolves to PUBLIC, `net.connect` is really made to the local server `port` (the test's TLS
// server, or its byte-counting target) and the socket reports `claimed` as its remote address.
// `mode`: "plain" (nothing else), "otel" (pass-through wrappers over `net.connect`, `tls.connect`
// and `http.ClientRequest`, as an APM agent installs them: they change nothing) and "refuse-agent"
// (a replaced `ClientRequest` that gives the request an agent). Everything is installed before the
// core is loaded, as a patch applied at start-up is. Prints one JSON line: the outcome and how many
// times each wrapper ran (a wrapper that never ran proves nothing).
import type * as DnsModule from "node:dns";
import type * as HttpModule from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as NetModule from "node:net";
import type * as TlsModule from "node:tls";

const load = createRequire(import.meta.url);
const dns = load("node:dns") as typeof DnsModule;
const http = load("node:http") as typeof HttpModule;
const net = load("node:net") as typeof NetModule;
const tls = load("node:tls") as typeof TlsModule;

const [url = "", mode = "plain", portText = "0", claimed = ""] = process.argv.slice(2);
const PUBLIC = "93.184.216.34";
const calls = { net: 0, tls: 0, request: 0 };

type Method = (this: unknown, ...args: unknown[]) => unknown;

function replace(target: object, name: string, wrap: (original: Method) => Method): void {
  Reflect.set(target, name, wrap(Reflect.get(target, name) as Method));
}

function simulateNetwork(): void {
  replace(
    dns,
    "lookup",
    () => (_name, options, done) =>
      Reflect.apply(
        done as Method,
        undefined,
        Reflect.get(Object(options), "all") === true
          ? [null, [{ address: PUBLIC, family: 4 }]]
          : [null, PUBLIC, 4],
      ),
  );
  replace(net, "connect", (connect) => (_options, ...rest) => {
    const socket = Reflect.apply(connect, net, [
      { host: "127.0.0.1", port: Number(portText) },
      ...rest,
    ]) as NetModule.Socket;
    Object.defineProperty(socket, "remoteAddress", { get: () => claimed || PUBLIC });
    return socket;
  });
}

/** What an APM agent (OpenTelemetry, dd-trace, New Relic) does: wraps, calls through, changes nothing. */
function instrument(): void {
  for (const [module, name, key] of [
    [net, "connect", "net"],
    [tls, "connect", "tls"],
  ] as const)
    replace(
      module,
      name,
      (original) =>
        function (this: unknown, ...args) {
          calls[key] += 1;
          return Reflect.apply(original, this, args);
        },
    );
  const Original = http.ClientRequest;
  Reflect.set(
    http,
    "ClientRequest",
    class extends Original {
      constructor(...args: ConstructorParameters<typeof Original>) {
        super(...args);
        calls.request += 1;
      }
    },
  );
}

function giveRequestAnAgent(): void {
  const Original = http.ClientRequest;
  // an agent that connects nowhere: the test makes no connection of its own
  const agent = new http.Agent();
  Reflect.set(agent, "createConnection", () => new net.Socket());
  Reflect.set(
    http,
    "ClientRequest",
    class extends Original {
      constructor(options: HttpModule.ClientRequestArgs) {
        super({ ...options, agent });
      }
    },
  );
}

async function main(): Promise<void> {
  simulateNetwork();
  if (mode === "otel") instrument();
  if (mode === "refuse-agent") giveRequestAnAgent();
  syncBuiltinESMExports();
  const [{ fetchedFile }, { httpsFileTransport }, { systemClock }, { kilobytes, seconds }] =
    await Promise.all([
      import("../../../../src/a2a/files/a2a-file-fetch.js"),
      import("../../../../src/a2a/files/a2a-file-transport.js"),
      import("../../../../src/infrastructure/clock.js"),
      import("../../../../src/units/index.js"),
    ]);
  const outcome = await fetchedFile({
    url,
    allowedOrigins: [new URL(url).origin],
    maxBytes: kilobytes(64),
    transport: httpsFileTransport,
    clock: systemClock,
    timeout: seconds(4),
    signal: new AbortController().signal,
  }).then(
    () => "fetched",
    (error: unknown) => String(Reflect.get(Object(Reflect.get(Object(error), "metadata")), "code")),
  );
  process.stdout.write(`${JSON.stringify({ outcome, calls })}\n`);
  process.exit(0);
}

void main();
