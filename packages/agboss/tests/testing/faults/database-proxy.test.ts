import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseProxy, ProxyState } from "../../../src/testing/faults/database-proxy.js";
import { tcpTargetOf } from "../../../src/testing/faults/world.js";

/** An echo server: what the proxy stands in front of. */
async function echoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A client of `port`, and what it read so far. */
async function client(
  port: number,
): Promise<{ socket: Socket; read: () => string; closed: Promise<void> }> {
  const socket = createConnection(port, "127.0.0.1");
  let text = "";
  socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve();
    });
  });
  await new Promise<void>((resolve) => socket.on("connect", resolve));
  return { socket, read: () => text, closed };
}

/** Until `condition` holds, a turn of the event loop at a time (bounded by the test's timeout). */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

/** A round trip through the proxy's connections: a second connection's echo came back. */
async function roundTrip(port: number): Promise<void> {
  const probe = await client(port);
  probe.socket.write("probe");
  await until(() => probe.read() === "probe");
  probe.socket.destroy();
}

const open: { close: () => unknown }[] = [];
afterEach(async () => {
  for (const thing of open.splice(0)) await thing.close();
});

describe("#484 scenario 8: the database proxy pauses, drops and restores a pod's connections", () => {
  it("forwards both ways, stalls while paused, delivers what waited once restored", async () => {
    const { server, port } = await echoServer();
    const proxy = new DatabaseProxy({ host: "127.0.0.1", port });
    open.push(proxy, server);
    const through = await client(await proxy.start());
    through.socket.write("one");
    await until(() => through.read() === "one");
    proxy.pause();
    expect(proxy.state).toBe(ProxyState.Paused);
    through.socket.write("two");
    // the server answered nothing: a round trip of the server alone comes back first
    await roundTrip(port);
    expect(through.read()).toBe("one");
    proxy.pause();
    proxy.restore();
    proxy.restore();
    await until(() => through.read() === "onetwo");
    through.socket.destroy();
  });

  it("drops every connection and refuses new ones until restored", async () => {
    const { server, port } = await echoServer();
    const proxy = new DatabaseProxy({ host: "127.0.0.1", port });
    open.push(proxy, server);
    const proxyPort = await proxy.start();
    const first = await client(proxyPort);
    proxy.drop();
    expect(proxy.state).toBe(ProxyState.Dropped);
    await first.closed;
    const refused = await client(proxyPort);
    await refused.closed;
    proxy.restore();
    await roundTrip(proxyPort);
  });

  it("a paused proxy holds a new connection's traffic too; close cuts everything", async () => {
    const { server, port } = await echoServer();
    const proxy = new DatabaseProxy({ host: "127.0.0.1", port });
    open.push(server);
    const proxyPort = await proxy.start();
    proxy.pause();
    const late = await client(proxyPort);
    late.socket.write("late");
    await roundTrip(port);
    expect(late.read()).toBe("");
    await proxy.close();
    await late.closed;
    await proxy.close();
  });

  it("knows a TCP database's address from its URL, and a file from a path", () => {
    expect(tcpTargetOf("postgres://u:p@db.local:5432/x?options=-c")).toEqual({
      host: "db.local",
      port: 5432,
    });
    expect(tcpTargetOf("/tmp/faults.sqlite")).toBeUndefined();
    expect(tcpTargetOf("file:///tmp/faults.sqlite")).toBeUndefined();
    expect(tcpTargetOf("postgres://db.local/x")).toBeUndefined();
  });
});
