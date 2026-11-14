import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseProxy } from "../../../src/testing/faults/database-proxy.js";

/**
 * #1017 — `DatabaseProxy.dropAfter(...patterns)`: the link is cut once the client's bytes matched
 * every pattern in order and were forwarded, so the database applies what it was asked and the
 * answer is lost: the lost answer after a COMMIT, on a real connection.
 */

/** A database: records what it received on each connection and answers each chunk with `ok`. */
async function database(): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const server = createServer((socket) => {
    let text = "";
    received.push(text);
    const at = received.length - 1;
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      received[at] = text;
      socket.write("ok");
    });
    socket.on("end", () => socket.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, received };
}

/** A client of `port`, what it read, and whether it was closed. */
async function client(
  port: number,
): Promise<{ socket: Socket; read: () => string; closed: Promise<void> }> {
  const socket = createConnection(port, "127.0.0.1");
  let text = "";
  socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) =>
    socket.on("close", () => {
      resolve();
    }),
  );
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  return { socket, read: () => text, closed };
}

const until = async (condition: () => boolean): Promise<void> => {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
};

const open: { close: () => unknown }[] = [];
afterEach(async () => {
  for (const thing of open.splice(0)) await thing.close();
});

describe("#1017: the database proxy cuts a link after the bytes that apply a write", () => {
  it("forwards the matching bytes, then cuts that link: the database got them, the client never hears", async () => {
    const db = await database();
    const proxy = new DatabaseProxy({ host: "127.0.0.1", port: db.port });
    open.push(proxy, db.server);
    const port = await proxy.start();
    proxy.dropAfter("charge:", "COMMIT");
    const link = await client(port);

    link.socket.write("INSERT charge:o-1");
    await until(() => link.read() === "ok");
    link.socket.write("COMMIT");
    await link.closed;

    await until(() => db.received[0] === "INSERT charge:o-1COMMIT");
    expect(link.read()).toBe("ok");
  });

  it("another link's COMMIT does not count, the cut is once, then new links work", async () => {
    const db = await database();
    const proxy = new DatabaseProxy({ host: "127.0.0.1", port: db.port });
    open.push(proxy, db.server);
    const port = await proxy.start();
    proxy.dropAfter("charge:", "COMMIT");
    const other = await client(port);
    const cut = await client(port);

    other.socket.write("COMMIT");
    await until(() => other.read() === "ok");
    cut.socket.write("charge:o-2 COMMIT");
    await cut.closed;
    const next = await client(port);
    next.socket.write("charge:o-3 COMMIT");
    await until(() => next.read() === "ok");

    expect(other.read()).toBe("ok");
    expect(cut.read()).toBe("");
    await until(() => db.received.includes("charge:o-2 COMMIT"));
  });

  it("takes a regular expression, and the function it returns disarms it", async () => {
    const db = await database();
    const proxy = new DatabaseProxy({ host: "127.0.0.1", port: db.port });
    open.push(proxy, db.server);
    const port = await proxy.start();
    const disarm = proxy.dropAfter(/EVALSHA/u);
    disarm();
    const link = await client(port);

    link.socket.write("EVALSHA x");
    await until(() => link.read() === "ok");

    expect(link.read()).toBe("ok");
  });
});
