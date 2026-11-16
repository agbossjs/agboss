// #1138: fetches of a file in a process of its own, under DNS rebinding, with a replaced
// `http.ClientRequest` (or `net.connect`) that would hand the request to another agent. Every TCP
// connect of the process goes through the guard below, at the lowest layer JavaScript reaches (the
// TCP handle's `connect`):
// - PUBLIC is really connected to the local TLS server `vhostPort` and reported as PUBLIC;
// - 127.0.0.1 is connected to as it is (the test's trap listens there, on the url's port);
// - any other address is refused (`blocked`): this process never connects off this machine.
// Arguments: the url, the mode, the vhost's port, the answers, the tick, the number of fetches, the
// other allowed origins (comma-separated).
// The answers are `seq:<answer>;<answer>…`, lookup n getting answer n (the last one repeats), an
// answer being addresses separated by `,`; `rebind` is `seq:PUBLIC;127.0.0.1`, `stable` `seq:PUBLIC`.
// The tick is when the stub resolver answers: `immediate` (a later turn of the loop, as `getaddrinfo`
// does), `nextTick`, or `sync` (in the call itself: an in-memory cache) — the last two before a
// request's socket is handed over (#1138's acceptance: a same-tick answer).
// `mode` is the replacement, installed before the core loads, as a patch applied at start-up is:
// - `none`: no replacement;
// - `drop-create-connection`: the options without `createConnection`;
// - `drop-agent`: without `agent` and `createConnection` (Node falls back to `http.globalAgent`);
// - `global-agent`: `agent` replaced by `http.globalAgent`;
// - `global-agent-bare`: that, without `lookup` and `localAddress` either;
// - `global-agent-name`: that, with `hostname` set back to the url's name (its own lookup);
// - `keepalive-name`: the same on a shared keep-alive `http.Agent`;
// - `from-scratch`: options of its own, from the url alone (nothing of the caller's), on that agent;
// - `request-error`: no agent change; an error emitted on the request (an interceptor failing it);
// - `net-name`: no `ClientRequest` replacement; `net.connect` / `net.createConnection` replaced to
//   connect to the url's name instead of the host they are given (their `lookup` kept).
// Reports (IPC, never stdout) one message: the outcomes, the lookups, every address the TCP layer
// was asked for, how often the replaced `ClientRequest` was constructed, the sockets left in
// `http.globalAgent` and the keep-alive agent; a second one if the process lingers.
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

const [url = "", mode = "none", vhostText = "0", answerText = "rebind", tick = "immediate"] =
  process.argv.slice(2);
const [fetchesText = "1", otherOrigins = ""] = process.argv.slice(7);
const PUBLIC = "93.184.216.34";
const LOOPBACK = "127.0.0.1";
const report = { lookups: 0, connects: [] as string[], blocked: 0, constructed: 0 };
const keepAlive = new http.Agent({ keepAlive: true });

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

const ALIASES: Record<string, string> = {
  rebind: `seq:${PUBLIC};${LOOPBACK}`,
  stable: `seq:${PUBLIC}`,
};

/** Lookup n's addresses: answer n of the sequence, the last one repeated. */
function answerOf(lookup: number): { address: string; family: number }[] {
  const answers = (ALIASES[answerText] ?? answerText).replace(/^seq:/, "").split(";");
  const answer = answers[Math.min(lookup, answers.length) - 1] ?? "";
  return answer.split(",").map((address) => ({ address, family: net.isIP(address) }));
}

const SCHEDULE: Record<string, (answer: () => void) => void> = {
  immediate: (answer) => setImmediate(answer),
  nextTick: (answer) => {
    process.nextTick(answer);
  },
  sync: (answer) => {
    answer();
  },
};

function stubResolver(): void {
  const schedule = SCHEDULE[tick] ?? SCHEDULE.immediate;
  Reflect.set(dns, "lookup", (_name: string, options: unknown, done: Method) => {
    report.lookups += 1;
    const addresses = answerOf(report.lookups);
    schedule?.(() => {
      const [first = { address: "", family: 4 }] = addresses;
      if (Reflect.get(Object(options), "all") === true)
        Reflect.apply(done, undefined, [null, addresses]);
      else Reflect.apply(done, undefined, [null, first.address, first.family]);
    });
  });
}

type Options = HttpModule.ClientRequestArgs & Record<string, unknown>;

const nameOf = (): string => new URL(url).hostname;

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
    hostname: nameOf(),
  }),
  "keepalive-name": ({ lookup: _l, localAddress: _a, ...rest }) => ({
    ...rest,
    agent: keepAlive,
    hostname: nameOf(),
  }),
  "from-scratch": () => ({
    protocol: "http:",
    hostname: nameOf(),
    port: Number(new URL(url).port),
    path: new URL(url).pathname,
    method: "GET",
    agent: keepAlive,
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
        report.constructed += 1;
        super(rewrite === undefined ? options : rewrite(options), callback);
        if (mode === "request-error")
          process.nextTick(() => this.emit("error", new Error("refused by an interceptor")));
      }
    },
  );
}

/** `net.connect` / `net.createConnection` that connect to the url's name, whatever host they get. */
function replaceNetConnect(): void {
  for (const name of ["connect", "createConnection"] as const) {
    const original = net[name] as Method;
    Reflect.set(net, name, (options: unknown, ...rest: unknown[]) =>
      typeof options === "object" && options !== null
        ? Reflect.apply(original, net, [{ ...options, host: nameOf() }, ...rest])
        : Reflect.apply(original, net, [options, ...rest]),
    );
  }
}

const pooledIn = (agent: HttpModule.Agent): number =>
  [agent.sockets, agent.freeSockets]
    .flatMap((byName) => Object.values(byName))
    .reduce((count, sockets) => count + (sockets?.length ?? 0), 0);

async function fetchedOnce(): Promise<string> {
  const [{ fetchedFile }, { httpsFileTransport }, { systemClock }, { kilobytes, seconds }] =
    await Promise.all([
      import("../../../../src/a2a/files/a2a-file-fetch.js"),
      import("../../../../src/a2a/files/a2a-file-transport.js"),
      import("../../../../src/infrastructure/clock.js"),
      import("../../../../src/units/index.js"),
    ]);
  return fetchedFile({
    url,
    allowedOrigins: [new URL(url).origin, ...otherOrigins.split(",").filter(Boolean)],
    maxBytes: kilobytes(64),
    transport: httpsFileTransport,
    clock: systemClock,
    timeout: seconds(4),
    signal: new AbortController().signal,
  }).then(
    () => "fetched",
    (error: unknown) => String(Reflect.get(Object(Reflect.get(Object(error), "metadata")), "code")),
  );
}

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
  if (mode === "net-name") replaceNetConnect();
  else if (mode !== "none") replaceClientRequest();
  syncBuiltinESMExports();
  const outcomes: string[] = [];
  for (let fetch = 0; fetch < Number(fetchesText); fetch += 1)
    outcomes.push(await (mode === "request-error" ? transportedAlone() : fetchedOnce()));
  // a connection a refused request's agent started has had time to be made (or pooled)
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pooled = pooledIn(http.globalAgent) + pooledIn(keepAlive);
  await reportToParent({ outcome: outcomes[0], outcomes, ...report, pooled });
  // a socket left open keeps the loop alive: the unref'd timer then finds it and says so
  reportIfSocketLingers();
}

void main();
