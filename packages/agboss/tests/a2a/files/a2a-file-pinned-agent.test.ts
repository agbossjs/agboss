/**
 * #1138: a file fetch connects to no address but the one the guarded resolver vetted — whatever a
 * replaced `http.ClientRequest` would do with a request (hand it to `http.globalAgent` or a shared
 * keep-alive agent, set the url's name back, build options of its own), whenever its resolver
 * answers (a later turn, the same tick, at once), on a redirect hop and on a fetch after a refused
 * one. The fetch writes its own HTTP/1.1 exchange on the vetted TLS socket, so no `ClientRequest`
 * — and no agent — is ever constructed. Each case is a child process
 * (proxy/file-rebind-process.ts) whose every TCP connect is guarded: the "public" address reaches
 * the local TLS server, 127.0.0.1 the trap on the url's port, anything else is refused there.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runNodeReporting } from "../../helpers/process.js";
import { startVhost, type Vhost } from "./proxy/file-vhost.js";
import { startNetwork, type Network } from "./proxy/servers.js";

const CHILD = fileURLToPath(new URL("./proxy/file-rebind-process.ts", import.meta.url));
const HOST = "files.example.test";
const PUBLIC = "93.184.216.34";

let vhost: Vhost;
let trap: Network;
beforeAll(async () => {
  [vhost, trap] = await Promise.all([startVhost(HOST), startNetwork()]);
});
afterAll(async () => {
  await Promise.all([vhost.close(), trap.close()]);
});
beforeEach(() => {
  vhost.reset();
  trap.reset();
});

interface Report {
  outcome: string;
  outcomes: string[];
  lookups: number;
  connects: string[];
  blocked: number;
  constructed: number;
  pooled: number;
  lingering: boolean;
}

interface Setup {
  readonly answers?: string;
  readonly tick?: string;
  readonly fetches?: number;
  readonly path?: string;
  readonly otherOrigins?: readonly string[];
}

const fileUrl = (path: string): string => `https://${HOST}:${String(trap.targetPort)}${path}`;

async function fetchedUnder(mode: string, setup: Setup = {}): Promise<Report> {
  const { answers = "rebind", tick = "immediate", fetches = 1, path = "/a.pdf" } = setup;
  const result = await runNodeReporting(
    [
      ...["--import", "tsx", CHILD, fileUrl(path), mode, String(vhost.port), answers, tick],
      ...[String(fetches), (setup.otherOrigins ?? []).join(",")],
    ],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: vhost.trust } },
  );
  if (result.status !== 0) throw new Error(`the child failed:\n${result.stderr}`);
  return {
    ...(result.messages[0] as Omit<Report, "lingering">),
    lingering: result.messages.length > 1,
  };
}

const PUBLIC_CONNECT = (): string => `${PUBLIC}:${String(trap.targetPort)}`;

/** Nothing reached the trap or another address; nothing was pooled or left open. */
function expectNothingUnvetted(fetched: Report): void {
  expect(fetched.blocked).toBe(0);
  expect(trap.targetConnections()).toBe(0);
  expect(trap.targetBytes()).toBe(0);
  expect(fetched.pooled).toBe(0);
  expect(fetched.lingering).toBe(false);
}

/** One fetch over the fetch's own connection: one lookup, one TCP connect, to the vetted address. */
function expectOnlyTheVettedPeer(fetched: Report): void {
  expectNothingUnvetted(fetched);
  expect(fetched.lookups).toBe(1);
  expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
  expect(vhost.connections()).toBe(1);
}

const REPLACEMENTS = [
  "drop-create-connection",
  "drop-agent",
  "global-agent",
  "global-agent-bare",
  "global-agent-name",
  "keepalive-name",
  "from-scratch",
] as const;
const TICKS = ["immediate", "nextTick", "sync"] as const;

describe("#1138: a replaced ClientRequest is never constructed, the fetch reaches only the vetted peer", () => {
  it("C0 control: no replacement, the file is fetched over the one checked connection", async () => {
    const fetched = await fetchedUnder("none");

    expect(fetched.outcome).toBe("fetched");
    expectOnlyTheVettedPeer(fetched);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);

  for (const tick of TICKS)
    for (const mode of REPLACEMENTS)
      it(`R ${mode}, the resolver answering ${tick}, rebinding: fetched from the vetted peer, 0 connections at the trap`, async () => {
        const fetched = await fetchedUnder(mode, { tick });

        expect(fetched.outcome).toBe("fetched");
        expect(fetched.constructed).toBe(0);
        expectOnlyTheVettedPeer(fetched);
        expect(vhost.requests).toEqual(["/a.pdf"]);
      }, 30_000);

  it("R2 #1138's acceptance repro: the url's name set back on a keep-alive agent, a same-tick resolver, two fetches — the second refused, nothing at the trap", async () => {
    const fetched = await fetchedUnder("keepalive-name", { tick: "nextTick", fetches: 2 });

    expect(fetched.outcomes).toEqual(["fetched", "a2a.file-address-denied"]);
    expect(fetched.constructed).toBe(0);
    expectNothingUnvetted(fetched);
    expect(fetched.lookups).toBe(2);
    expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);

  it("G2 an interceptor that fails the request it would make: never asked, the transport responds", async () => {
    const fetched = await fetchedUnder("request-error");

    expect(fetched.outcome).toBe("responded");
    expect(fetched.constructed).toBe(0);
    expectOnlyTheVettedPeer(fetched);
  }, 30_000);
});

describe("#1138: the TCP connect itself is pinned to the vetted address", () => {
  for (const tick of TICKS)
    it(`N net.connect replaced to connect to the url's name, the resolver answering ${tick}: the pinned lookup answers the vetted address, no second lookup`, async () => {
      const fetched = await fetchedUnder("net-name", { tick });

      expect(fetched.outcome).toBe("fetched");
      expectOnlyTheVettedPeer(fetched);
    }, 30_000);
});

describe("#1138: a keep-alive socket is never reused across a refused request", () => {
  it("K1 refused first (the name answers 127.0.0.1), then fetched: the second fetch makes its own connection, nothing pooled", async () => {
    const fetched = await fetchedUnder("keepalive-name", {
      answers: `seq:127.0.0.1;${PUBLIC}`,
      tick: "sync",
      fetches: 2,
    });

    expect(fetched.outcomes).toEqual(["a2a.file-address-denied", "fetched"]);
    expectNothingUnvetted(fetched);
    expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
    expect(vhost.connections()).toBe(1);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);

  it("K2 fetched first, then refused (rebound): the refused fetch reuses nothing, one request only", async () => {
    const fetched = await fetchedUnder("global-agent-name", { tick: "sync", fetches: 2 });

    expect(fetched.outcomes).toEqual(["fetched", "a2a.file-address-denied"]);
    expectNothingUnvetted(fetched);
    expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
    expect(vhost.connections()).toBe(1);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);
});

describe("#1138: answers with a denied address connect nowhere", () => {
  const MIXED = [`${PUBLIC},127.0.0.1`, `127.0.0.1,${PUBLIC}`, `${PUBLIC},10.0.0.7`];
  for (const answer of MIXED)
    it(`M a name answering ${answer} (public and private mixed): refused before any connect`, async () => {
      const fetched = await fetchedUnder("none", { answers: `seq:${answer}`, tick: "sync" });

      expect(fetched.outcome).toBe("a2a.file-address-denied");
      expectNothingUnvetted(fetched);
      expect(fetched.connects).toEqual([]);
      expect(vhost.connections()).toBe(0);
    }, 30_000);

  const MAPPED = [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "::ffff:0:7f00:1",
    "::127.0.0.1",
    "2002:7f00:1::",
    "::ffff:0.0.0.0",
    "fd00:ec2::254",
    "fe80::1",
    "ff02::1",
    "::",
  ];
  for (const address of MAPPED)
    it(`V a name answering ${address} (an IPv6 form of a denied address): refused before any connect`, async () => {
      const fetched = await fetchedUnder("none", { answers: `seq:${address}` });

      expect(fetched.outcome).toBe("a2a.file-address-denied");
      expectNothingUnvetted(fetched);
      expect(fetched.connects).toEqual([]);
    }, 30_000);
});

describe("#1138: a redirect hop is vetted as the first one", () => {
  const redirectTo = (location: string): string => `/redirect?to=${encodeURIComponent(location)}`;

  it("D1 a redirect to 127.0.0.1 on an allowed origin: refused, no connect beyond the first hop's", async () => {
    const target = `https://127.0.0.1:${String(trap.targetPort)}/x`;
    const fetched = await fetchedUnder("keepalive-name", {
      path: redirectTo(target),
      otherOrigins: [new URL(target).origin],
      tick: "sync",
    });

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expectNothingUnvetted(fetched);
    expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
  }, 30_000);

  it("D2 a redirect to an IPv4-mapped loopback literal on an allowed origin: refused, no connect beyond the first hop's", async () => {
    const target = `https://[::ffff:127.0.0.1]:${String(trap.targetPort)}/x`;
    const fetched = await fetchedUnder("none", {
      path: redirectTo(target),
      otherOrigins: [new URL(target).origin],
    });

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expectNothingUnvetted(fetched);
    expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
  }, 30_000);

  it("D3 a redirect to the same name, rebound to 127.0.0.1 for the hop, same-tick: refused, one request only", async () => {
    const fetched = await fetchedUnder("global-agent-name", {
      path: redirectTo(fileUrl("/a.pdf")),
      tick: "nextTick",
    });

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expectNothingUnvetted(fetched);
    expect(fetched.lookups).toBe(2);
    expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
    expect(vhost.requests).toHaveLength(1);
  }, 30_000);

  it("D4 a redirect to another allowed name answering a private address: refused before its connect", async () => {
    const other = `https://other.example.test:${String(trap.targetPort)}/x`;
    const fetched = await fetchedUnder("none", {
      path: redirectTo(other),
      otherOrigins: [new URL(other).origin],
      answers: `seq:${PUBLIC};10.1.2.3`,
    });

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expectNothingUnvetted(fetched);
    expect(fetched.connects).toEqual([PUBLIC_CONNECT()]);
  }, 30_000);
});
