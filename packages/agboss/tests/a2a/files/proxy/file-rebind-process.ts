// #1138: one fetch of a file in a process of its own, under DNS rebinding, with a replaced
// `http.ClientRequest` that hands the request to another agent. Every TCP connect of the process
// goes through the guard below, at the lowest layer JavaScript reaches (the TCP handle's `connect`):
// - PUBLIC is really connected to the local TLS server `vhostPort` and reported as PUBLIC;
// - 127.0.0.1 is connected to as it is (the test's trap listens there, on the url's port);
// - any other address is refused (`blocked`): this process never connects off this machine.
// The name answers PUBLIC on the first lookup and, with `rebind`, 127.0.0.1 on every later one
// (`stable`: PUBLIC every time); answers come on a later turn of the loop, as a real lookup's do.
// `mode` is the replaced `ClientRequest` (installed before the core loads, as a patch applied at
// start-up is):
// - `none`: no replacement;
// - `drop-create-connection`: the options without `createConnection`;
// - `drop-agent`: without `agent` and `createConnection` (Node falls back to `http.globalAgent`);
// - `global-agent`: `agent` replaced by `http.globalAgent`;
// - `global-agent-bare`: that, without `lookup` and `localAddress` either;
// - `global-agent-name`: that, with `hostname` set back to the url's name (its own lookup);
// - `request-error`: no agent change; an error emitted on the request (an interceptor failing it),
//   the transport called on its own (the fetch's end, which aborts the signal, cannot clean up).
// Reports (IPC, never stdout) one message: the outcome, the lookups, every address the TCP layer was
// asked for, the sockets left in `http.globalAgent`; a second one if the process lingers.
import type * as DnsModule from "node:dns";
import type * as HttpModule from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as NetModule from "node:net";
import { constants } from "node:os";
import { report as reportToParent, reportIfSocketLingers } from "../../../helpers/child-channel.js";

const load = createRequire(import.meta.url);
const dns = load("node:dns") as typeof DnsModule;
const http = load("node:http") as typeof HttpModule;
const net = load("node:net") as typeof NetModule;

const [url = "", mode = "none", vhostText = "0", answers = "rebind"] = process.argv.slice(2);
const PUBLIC = "93.184.216.34";
const LOOPBACK = "127.0.0.1";
const report = { lookups: 0, connects: [] as string[], blocked: 0 };

type Method = (this: unknown, ...args: unknown[]) => unknown;

/** The TCP handle's prototype, from a server's handle (the only way to it without internals). */
async function tcpPrototype(): Promise<object> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const handle: unknown = Reflect.get(server, "_handle");
  await new Promise((resolve) => server.close(resolve));
  if (typeof handle !== "object" || handle === null) throw new Error("no TCP handle to guard");
  return Object.getPrototypeOf(handle) as object;
}

async function guardConnects(): Promise<void> {
  const prototype = await tcpPrototype();
  const mapped = new WeakSet<object>();
  for (const name of ["connect", "connect6"]) {
    const original = Reflect.get(prototype, name) as Method;
    Reflect.set(prototype, name, function (this: object, ...args: unknown[]) {
      const [request, address, port, ...rest] = args;
      report.connects.push(`${String(address)}:${String(port)}`);
      if (address === PUBLIC) {
        mapped.add(this);
        return Reflect.apply(original, this, [request, LOOPBACK, Number(vhostText), ...rest]);
      }
      if (address === LOOPBACK) return Reflect.apply(original, this, args);
      report.blocked += 1;
      return -constants.errno.ECONNREFUSED;
    });
  }
  const getpeername = Reflect.get(prototype, "getpeername") as Method;
  Reflect.set(prototype, "getpeername", function (this: object, out: Record<string, unknown>) {
    const failed = Reflect.apply(getpeername, this, [out]);
    if (mapped.has(this)) out.address = PUBLIC;
    return failed;
  });
}

function stubResolver(): void {
  Reflect.set(dns, "lookup", (_name: string, options: unknown, done: Method) => {
    report.lookups += 1;
    const address = answers === "rebind" && report.lookups > 1 ? LOOPBACK : PUBLIC;
    setImmediate(() => {
      if (Reflect.get(Object(options), "all") === true)
        Reflect.apply(done, undefined, [null, [{ address, family: 4 }]]);
      else Reflect.apply(done, undefined, [null, address, 4]);
    });
  });
}

type Options = HttpModule.ClientRequestArgs & Record<string, unknown>;

const REWRITES: Record<string, (options: Options) => Options> = {
  "drop-create-connection": ({ createConnection: _c, ...rest }) => rest,
  "drop-agent": ({ createConnection: _c, agent: _a, ...rest }) => rest,
  "global-agent": (options) => ({ ...options, agent: http.globalAgent }),
  "global-agent-bare": ({ lookup: _l, localAddress: _a, ...rest }) => ({
    ...rest,
    agent: http.globalAgent,
  }),
  "global-agent-name": ({ lookup: _l, localAddress: _a, ...rest }) => ({
    ...rest,
    agent: http.globalAgent,
    hostname: new URL(url).hostname,
  }),
};

function replaceClientRequest(): void {
  const Original = http.ClientRequest;
  const rewrite = REWRITES[mode];
  Reflect.set(
    http,
    "ClientRequest",
    class extends Original {
      constructor(options: Options, callback?: (response: HttpModule.IncomingMessage) => void) {
        super(rewrite === undefined ? options : rewrite(options), callback);
        if (mode === "request-error")
          process.nextTick(() => this.emit("error", new Error("refused by an interceptor")));
      }
    },
  );
}

const pooled = (): number =>
  [http.globalAgent.sockets, http.globalAgent.freeSockets]
    .flatMap((byName) => Object.values(byName))
    .reduce((count, sockets) => count + (sockets?.length ?? 0), 0);

/** One `GET` by the transport alone, its signal never aborted: what is left open stays open. */
async function transportedAlone(): Promise<string> {
  const { httpsFileTransport } = await import("../../../../src/a2a/files/a2a-file-transport.js");
  return httpsFileTransport(new URL(url), new AbortController().signal).then(
    (response) => {
      response.cancel();
      return "responded";
    },
    () => "failed",
  );
}

async function main(): Promise<void> {
  await guardConnects();
  stubResolver();
  if (mode !== "none") replaceClientRequest();
  syncBuiltinESMExports();
  const [{ fetchedFile }, { httpsFileTransport }, { systemClock }, { kilobytes, seconds }] =
    await Promise.all([
      import("../../../../src/a2a/files/a2a-file-fetch.js"),
      import("../../../../src/a2a/files/a2a-file-transport.js"),
      import("../../../../src/infrastructure/clock.js"),
      import("../../../../src/units/index.js"),
    ]);
  const outcome =
    mode === "request-error"
      ? await transportedAlone()
      : await fetchedFile({
          url,
          allowedOrigins: [new URL(url).origin],
          maxBytes: kilobytes(64),
          transport: httpsFileTransport,
          clock: systemClock,
          timeout: seconds(4),
          signal: new AbortController().signal,
        }).then(
          () => "fetched",
          (error: unknown) =>
            String(Reflect.get(Object(Reflect.get(Object(error), "metadata")), "code")),
        );
  // a connection the refused request's agent started has had time to be made (or pooled)
  await new Promise((resolve) => setTimeout(resolve, 300));
  await reportToParent({ outcome, ...report, pooled: pooled() });
  // a socket left open keeps the loop alive: the unref'd timer then finds it and says so
  reportIfSocketLingers();
}

void main();
