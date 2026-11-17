/**
 * #1244: the file fetch's own connection (a2a-file-connect.ts) and address checks (a2a-file-address.ts),
 * in this process, on a simulated public network (support/public-network.ts): what each connect step
 * asks of `net` and `tls`, a peer that is not the address asked for, a connection that times out,
 * is refused or is aborted, the listeners each leaves, and the next address after a refused one.
 */
import { getEventListeners } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  installPublicNetwork,
  loadFileStack,
  PUBLIC,
  type FileStack,
  type PublicNetwork,
} from "./support/public-network.js";
import { closedPort, startScriptServer, type ScriptServer } from "./support/script-server.js";

const HOST = "files.example.test";
let server: ScriptServer;
let network: PublicNetwork;
let stack: FileStack;

beforeAll(async () => {
  server = await startScriptServer(HOST);
  network = installPublicNetwork(server);
  stack = await loadFileStack();
});
afterAll(async () => {
  network.restore();
  await server.close();
});
beforeEach(() => {
  network.reset();
});

const live = new AbortController().signal;

/** `connectionTo`, its TLS socket's later errors (a handshake the test does not finish) swallowed. */
const connectedTo = async (url: URL, signal: AbortSignal) => {
  const connection = await stack.connectionTo(url, signal);
  connection.secure.on("error", () => undefined);
  return connection;
};
const codeOf = (error: unknown): unknown => Reflect.get(Object(error), "code");

describe("#1244 the pinned TCP connection", () => {
  it("K1 is made to the address itself as the host, with a lookup that answers only it", async () => {
    const socket = await stack.rawSocketTo(PUBLIC, 8443, live);
    socket.destroy();

    const [options] = network.seen.netOptions;
    expect(options).toMatchObject({ host: PUBLIC, port: 8443 });
    const lookup = options?.lookup as (...args: unknown[]) => void;
    const answers: unknown[][] = [];
    lookup("any.other.name", { all: true }, (...args: unknown[]) => answers.push(args));
    lookup("any.other.name", {}, (...args: unknown[]) => answers.push(args));
    expect(answers).toEqual([
      [null, [{ address: PUBLIC, family: 4 }]],
      [null, PUBLIC, 4],
    ]);
  });

  it("K2 an IPv6 address is pinned with its family", async () => {
    const socket = await stack.rawSocketTo("2606:4700::1111", 443, live);
    socket.destroy();
    const lookup = network.seen.netOptions[0]?.lookup as (...args: unknown[]) => void;
    const answers: unknown[][] = [];
    lookup("x", { all: true }, (...args: unknown[]) => answers.push(args));
    expect(answers).toEqual([[null, [{ address: "2606:4700::1111", family: 6 }]]]);
  });

  it("K3 the socket's remote address is checked before anything is sent: another address, a denied one or none destroys it", async () => {
    for (const claimed of [
      "93.184.216.99",
      "127.0.0.1",
      "10.0.0.1",
      "::ffff:7f00:1",
      "2606:4700::1111",
      "",
    ]) {
      network.claimed = claimed;
      const sockets: Socket[] = [];
      const failure = await stack.rawSocketTo(PUBLIC, server.port, live).then(
        (socket) => {
          sockets.push(socket);
          return undefined;
        },
        (error: unknown) => error,
      );
      expect(codeOf(failure), claimed).toBe("A2A_FILE_ADDRESS_DENIED");
      expect(failure, claimed).toMatchObject({
        message: "the file's host resolves to an address it is never fetched from",
      });
      expect(sockets).toEqual([]);
    }
    expect(server.received).toEqual([]);
  });

  it("K4 the address it was asked for, in any spelling the socket reports, is accepted", async () => {
    for (const claimed of [PUBLIC, `::ffff:${PUBLIC}`, `[${PUBLIC}]`]) {
      network.claimed = claimed;
      const socket = await stack.rawSocketTo(PUBLIC, server.port, live);
      expect(socket.destroyed, claimed).toBe(false);
      socket.destroy();
    }
  });

  it("K5 a connection nobody answers times out, with its words, and no later abort is heard", async () => {
    network.stalled.add(PUBLIC);
    const controller = new AbortController();

    await expect(stack.rawSocketTo(PUBLIC, 1, controller.signal, 20)).rejects.toMatchObject({
      message: "the connection timed out",
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("K6 a refused connection rejects with the socket's error and leaves no listener on the signal", async () => {
    const controller = new AbortController();
    network.routes.set(PUBLIC, await closedPort());

    const failure = await stack.rawSocketTo(PUBLIC, 1, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(codeOf(failure)).toBe("ECONNREFUSED");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("K7 a connected socket keeps no abort listener, no error listener and no idle timeout", async () => {
    const controller = new AbortController();
    const socket = await stack.rawSocketTo(PUBLIC, server.port, controller.signal, 60);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(socket.listenerCount("error")).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it("K8 an abort while connecting destroys the socket with `the file fetch was aborted`", async () => {
    const controller = new AbortController();
    const connecting = stack.rawSocketTo(PUBLIC, server.port, controller.signal);
    controller.abort();
    await expect(connecting).rejects.toMatchObject({ message: "the file fetch was aborted" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("K9 an abort that already fired opens no socket", async () => {
    await expect(stack.rawSocketTo(PUBLIC, server.port, AbortSignal.abort())).rejects.toMatchObject(
      { message: "the file fetch was aborted" },
    );
    expect(network.seen.netOptions).toEqual([]);
  });
});

describe("#1244 which peer is expected", () => {
  const { isExpectedPeer } = {
    isExpectedPeer: (
      ...args: Parameters<
        typeof import("../../../src/a2a/files/a2a-file-connect.js").isExpectedPeer
      >
    ) => stack.isExpectedPeer(...args),
  };

  it("E1 an answered address, in another case, with brackets, a zone or as IPv4-mapped, is the peer", () => {
    const answers = new Set(["2606:4700::AAAA", "93.184.216.34"]);
    for (const remote of [
      "2606:4700::aaaa",
      "[2606:4700::aaaa]",
      "2606:4700::aaaa%eth0",
      "::ffff:93.184.216.34",
    ])
      expect(isExpectedPeer(remote, answers, HOST), remote).toBe(true);
    expect(isExpectedPeer("93.184.216.34", new Set(["[93.184.216.34]"]), HOST)).toBe(true);
    expect(isExpectedPeer("93.184.216.34", new Set(["93.184.216.34%eth0"]), HOST)).toBe(true);
  });

  it("E2 text that only looks like an answer once a bracket or a zone is cut inside it is not the peer", () => {
    expect(isExpectedPeer("2606:4700::1", new Set(["2606:4700::[1"]), HOST)).toBe(false);
    expect(isExpectedPeer("2606:4700::11", new Set(["2606:4700::1]1"]), HOST)).toBe(false);
    expect(isExpectedPeer("93.184.216.34", new Set(["93.184.216.34]x"]), HOST)).toBe(false);
    expect(isExpectedPeer("93.184.216.3", new Set(["93.184.216.3%4"]), HOST)).toBe(true);
    expect(isExpectedPeer("93.184.216.34", new Set(["93.184.216.3%4"]), HOST)).toBe(false);
  });

  it("E3 a mapped address that is only a prefix of the text is not stripped", () => {
    expect(isExpectedPeer("93.184.216.34", new Set(["x::ffff:93.184.216.34"]), HOST)).toBe(false);
    expect(isExpectedPeer("::ffff:2606:4700", new Set(["2606:4700"]), HOST)).toBe(false);
  });

  it("E3b a mapped prefix inside the text is not stripped to make a match", () => {
    expect(isExpectedPeer("11.2.3.4", new Set(["1::ffff:1.2.3.4"]), HOST)).toBe(false);
    expect(isExpectedPeer("1.2.3.4", new Set(["::ffff:1.2.3.4"]), HOST)).toBe(true);
  });

  it("E4 no remote, a denied remote, no answers, or another address is not the peer", () => {
    expect(isExpectedPeer(undefined, new Set([PUBLIC]), HOST)).toBe(false);
    expect(isExpectedPeer("10.0.0.1", new Set(["10.0.0.1"]), HOST)).toBe(false);
    expect(isExpectedPeer(PUBLIC, undefined, HOST)).toBe(false);
    expect(isExpectedPeer(PUBLIC, new Set(["93.184.216.35"]), HOST)).toBe(false);
    expect(isExpectedPeer(PUBLIC, new Set(), HOST)).toBe(false);
  });

  it("E5 an IP literal host is its own expected peer, whatever the answers", () => {
    expect(isExpectedPeer(PUBLIC, undefined, PUBLIC)).toBe(true);
    expect(isExpectedPeer(PUBLIC, new Set(["93.184.216.35"]), PUBLIC)).toBe(true);
    expect(isExpectedPeer("93.184.216.35", new Set([PUBLIC]), PUBLIC)).toBe(false);
  });
});

describe("#1244 the connection to a url", () => {
  it("U1 a name: resolved once, connected to its address on port 443 by default, TLS with the name as SNI and host", async () => {
    const { secure, address } = await connectedTo(new URL(`https://${HOST}/f`), live);
    secure.destroy();

    expect(address).toBe(PUBLIC);
    expect(network.seen.lookups).toEqual([HOST]);
    expect(network.seen.netOptions).toHaveLength(1);
    expect(network.seen.netOptions[0]).toMatchObject({ host: PUBLIC, port: 443 });
    expect(network.seen.tlsOptions).toHaveLength(1);
    expect(network.seen.tlsOptions[0]).toMatchObject({ host: HOST, servername: HOST });
    expect(network.seen.tlsOptions[0]?.socket).toBeDefined();
  });

  it("U2 an explicit port is the port; an IPv6 literal is connected to without a lookup, unbracketed, with no SNI", async () => {
    const named = await connectedTo(new URL(`https://${HOST}:8443/f`), live);
    named.secure.destroy();
    expect(network.seen.netOptions[0]).toMatchObject({ port: 8443 });

    network.seen.netOptions.length = 0;
    network.seen.tlsOptions.length = 0;
    network.seen.lookups.length = 0;
    const literal = await connectedTo(new URL("https://[2606:4700::1111]:8443/f"), live).catch(
      (error: unknown) => error,
    );
    // the server's certificate is for a name: the handshake is refused, after the socket is made
    expect(codeOf(literal)).not.toBe("A2A_FILE_ADDRESS_DENIED");
    expect(network.seen.lookups).toEqual([]);
    expect(network.seen.netOptions[0]).toMatchObject({ host: "2606:4700::1111", port: 8443 });
    expect(network.seen.tlsOptions[0]).toMatchObject({ host: "2606:4700::1111" });
    expect(Object.keys(network.seen.tlsOptions[0] ?? {})).not.toContain("servername");
    if (typeof literal === "object" && literal !== null && "secure" in literal)
      (literal.secure as Socket).destroy();
  });

  it("U3 a name with a denied address among its answers refuses at the lookup: no connection is made", async () => {
    for (const answers of [["127.0.0.1"], [PUBLIC, "10.0.0.1"], ["10.0.0.1", PUBLIC], ["::1"]]) {
      network.answers = answers;
      await expect(
        stack.connectionTo(new URL(`https://${HOST}/f`), live),
        answers.join(),
      ).rejects.toMatchObject({ code: "A2A_FILE_ADDRESS_DENIED" });
    }
    expect(network.seen.netOptions).toEqual([]);
  });

  it("U4 an IP literal that is denied is refused with no connection", async () => {
    await expect(connectedTo(new URL("https://10.0.0.1/f"), live)).rejects.toMatchObject({
      code: "A2A_FILE_ADDRESS_DENIED",
    });
    expect(network.seen.netOptions).toEqual([]);
  });

  it("U5 after a refused connection the next address is tried; the first denied peer ends it at once", async () => {
    const second = "93.184.216.35";
    network.answers = [PUBLIC, second];
    network.routes.set(PUBLIC, await closedPort());
    const { secure, address } = await connectedTo(new URL(`https://${HOST}/f`), live);
    secure.destroy();
    expect(address).toBe(second);
    expect(network.seen.netOptions.map((options) => options.host)).toEqual([PUBLIC, second]);

    network.seen.netOptions.length = 0;
    network.routes.clear();
    network.claimed = "10.0.0.1"; // the first connection's peer is a denied address
    await expect(connectedTo(new URL(`https://${HOST}/f`), live)).rejects.toMatchObject({
      code: "A2A_FILE_ADDRESS_DENIED",
    });
    expect(network.seen.netOptions).toHaveLength(1);
  });

  it("U6 when every address is refused the last failure is the error", async () => {
    network.answers = [PUBLIC, "93.184.216.35"];
    const port = await closedPort();
    network.routes.set(PUBLIC, port);
    network.routes.set("93.184.216.35", port);
    await expect(connectedTo(new URL(`https://${HOST}/f`), live)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(network.seen.netOptions).toHaveLength(2);
  });

  it("U7 an abort while the first address does not answer ends the loop: the next is not tried", async () => {
    const controller = new AbortController();
    network.answers = [PUBLIC, "93.184.216.35"];
    network.stalled.add(PUBLIC);
    const connecting = connectedTo(new URL(`https://${HOST}/f`), controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 30);

    await expect(connecting).rejects.toMatchObject({ message: "the file fetch was aborted" });
    expect(network.seen.netOptions).toHaveLength(1);
  });
});

describe("#1244 the host of a url", () => {
  it("O1 brackets come off an IPv6 literal when both are there, and nothing else is cut", () => {
    expect(stack.unbracketed("[2606:4700::1111]")).toBe("2606:4700::1111");
    expect(stack.unbracketed("[]")).toBe("");
    for (const text of [
      "[2606:4700::1111",
      "2606:4700::1111]",
      "2606:4700::1111",
      "files.example",
      "",
    ])
      expect(stack.unbracketed(text), text).toBe(text);
    expect(stack.hostOf(new URL("https://[2606:4700::1111]:8443/a"))).toBe("2606:4700::1111");
    expect(stack.hostOf(new URL("https://files.example:8443/a"))).toBe("files.example");
    expect(stack.hostOf(new URL("https://10.1.2.3/a"))).toBe("10.1.2.3");
  });

  it("O3 a zone is cut at its first percent sign, to the end", () => {
    expect(stack.withoutZone("fe80::1%eth0")).toBe("fe80::1");
    expect(stack.withoutZone("fe80::1%a%b")).toBe("fe80::1");
    expect(stack.withoutZone("fe80::1")).toBe("fe80::1");
    expect(stack.withoutZone("%x")).toBe("");
  });

  it("O4 an IP literal is connected to with no lookup at all", async () => {
    const asked: string[] = [];
    const connection = await connectedTo(new URL(`https://${PUBLIC}/f`), live);
    connection.secure.destroy();
    const { secure } = await stack.connectionTo(new URL(`https://${PUBLIC}/f`), live, (name) => {
      asked.push(name);
    });
    secure.on("error", () => undefined);
    secure.destroy();
    expect(asked).toEqual([]);
    expect(network.seen.lookups).toEqual([]);
  });

  it("O2 a resolver that never answers cannot hold a fetch whose signal already fired", async () => {
    await expect(
      stack.connectionTo(new URL(`https://${HOST}/f`), AbortSignal.abort(), () => undefined),
    ).rejects.toMatchObject({ message: "the file fetch was aborted" });
  });
});

describe("#1244 the review's findings in the connection", () => {
  it("W1 a port that is none is refused before any socket", async () => {
    await expect(stack.connectionTo(new URL(`https://${HOST}:0/f`), live)).rejects.toMatchObject({
      message: "the file's url has no usable port",
    });
    expect(network.seen.netOptions).toEqual([]);
    for (const port of ["1", "65535"])
      await expect(
        stack.connectionTo(new URL(`https://${HOST}:${port}/f`), live).then((c) => {
          c.secure.on("error", () => undefined);
          c.secure.destroy();
          return "connected";
        }),
      ).resolves.toBe("connected");
  });

  it("W2 a TLS socket that fails before the exchange listens does not crash the process", async () => {
    network.failsTlsAtOnce = true;
    const crashes: unknown[] = [];
    const heard = (error: unknown): void => {
      crashes.push(error);
    };
    process.on("uncaughtException", heard);
    try {
      const { secure } = await stack.connectionTo(new URL(`https://${HOST}/f`), live);
      await new Promise((resolve) => setTimeout(resolve, 30));
      secure.destroy();
    } finally {
      process.off("uncaughtException", heard);
    }
    expect(crashes).toEqual([]);
  });

  it("W3 the system resolver is the dns.lookup the module found at load, whatever replaces it later", async () => {
    const dns = createRequire(import.meta.url)("node:dns") as { lookup: unknown };
    const found = dns.lookup;
    const asked: string[] = [];
    dns.lookup = (name: string): void => {
      asked.push(name);
      throw new Error("a lookup patched after the load must never be asked");
    };
    syncBuiltinESMExports();
    try {
      await expect(stack.addressesOf(HOST)).resolves.toEqual([PUBLIC]);
    } finally {
      dns.lookup = found;
      syncBuiltinESMExports();
    }
    expect(asked).toEqual([]);
  });
});

describe("#1244 the resolver", () => {
  it("R1 the guarded lookup answers every address (all) or the first one, and tells which it vetted", () => {
    const resolve = (
      _name: string,
      done: (error: null, found: { address: string; family: number }[]) => void,
    ): void => {
      done(null, [
        { address: PUBLIC, family: 4 },
        { address: "93.184.216.35", family: 4 },
      ]);
    };
    const told: (readonly string[])[] = [];
    const lookup = stack.guardedLookupOf(resolve, (addresses) => told.push(addresses));
    const got: unknown[][] = [];
    lookup(HOST, { all: true }, (...args) => got.push(args));
    lookup(HOST, {}, (...args) => got.push(args));
    expect(got).toEqual([
      [
        null,
        [
          { address: PUBLIC, family: 4 },
          { address: "93.184.216.35", family: 4 },
        ],
      ],
      [null, PUBLIC, 4],
    ]);
    expect(told).toEqual([
      [PUBLIC, "93.184.216.35"],
      [PUBLIC, "93.184.216.35"],
    ]);
  });

  it("R2 a resolver's error is passed on with an empty address and family 4; an empty answer is denied", () => {
    const failing = stack.guardedLookupOf((_name, done) => {
      done(Object.assign(new Error("nope"), { code: "ENOTFOUND" }), []);
    });
    const got: unknown[][] = [];
    failing(HOST, {}, (...args) => got.push(args));
    expect(got).toEqual([[expect.objectContaining({ code: "ENOTFOUND" }), "", 4]]);

    const empty = stack.guardedLookupOf((_name, done) => {
      done(null, []);
    });
    const denied: unknown[][] = [];
    empty(HOST, {}, (...args) => denied.push(args));
    expect(denied).toEqual([[expect.objectContaining({ code: "A2A_FILE_ADDRESS_DENIED" }), "", 4]]);
  });

  it("R3 addressesOf is the vetted addresses, in order; a denied one or an error rejects", async () => {
    const answer =
      (...addresses: string[]) =>
      (
        _name: string,
        done: (error: null, found: { address: string; family: number }[]) => void,
      ): void => {
        done(
          null,
          addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
        );
      };
    await expect(stack.addressesOf(HOST, answer(PUBLIC, "2606:4700::1111"))).resolves.toEqual([
      PUBLIC,
      "2606:4700::1111",
    ]);
    await expect(stack.addressesOf(HOST, answer(PUBLIC, "127.0.0.1"))).rejects.toMatchObject({
      code: "A2A_FILE_ADDRESS_DENIED",
    });
    await expect(
      stack.addressesOf(HOST, (_name, done) => {
        done(Object.assign(new Error("nope"), { code: "ENOTFOUND" }), []);
      }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("R4 the system resolver (dns.lookup) is asked for all addresses of the name", async () => {
    network.answers = [PUBLIC, "2606:4700::1111"];
    await expect(stack.addressesOf(HOST)).resolves.toEqual([PUBLIC, "2606:4700::1111"]);
    network.answers = ["127.0.0.1"];
    await expect(stack.addressesOf(HOST)).rejects.toMatchObject({
      code: "A2A_FILE_ADDRESS_DENIED",
    });
    expect(network.seen.lookups).toEqual([HOST, HOST]);
  });

  it("R5 an address as the deny list sees it: brackets and a zone are cut, text that is no address is denied", () => {
    expect(stack.isDeniedAddress("[::1]")).toBe(true);
    expect(stack.isDeniedAddress("fe80::1%eth0")).toBe(true);
    expect(stack.isDeniedAddress("[fe80::1%eth0]")).toBe(true);
    expect(stack.isDeniedAddress("[2606:4700::1111]")).toBe(false);
    expect(stack.isDeniedAddress("2606:4700::1111%eth0")).toBe(false);
    expect(stack.isDeniedAddress("93.184.216.34")).toBe(false);
    expect(stack.isDeniedAddress("10.0.0.1")).toBe(true);
    expect(stack.isDeniedAddress("::1]x")).toBe(true);
    expect(stack.isDeniedAddress("[[::1")).toBe(true);
    expect(stack.isDeniedAddress("example.test")).toBe(true);
    expect(stack.isDeniedAddress("")).toBe(true);
    expect(stack.deniedError()).toMatchObject({
      code: "A2A_FILE_ADDRESS_DENIED",
      message: "the file's host resolves to an address it is never fetched from",
    });
  });
});
