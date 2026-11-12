// A real local CONNECT proxy that tunnels for real, and a loopback "file server" that counts the
// connections it sees — shared by the #916 tests, so a fetch that went through the proxy (or
// connected without the guard) reaches the target and is counted.
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";

export interface Network {
  /** Where the proxy was asked to tunnel to (`CONNECT`), in order. */
  readonly tunnels: string[];
  /** Connections the target saw. */
  readonly targetConnections: () => number;
  readonly targetPort: number;
  readonly proxyUrl: string;
  readonly reset: () => void;
  readonly close: () => Promise<void>;
}

const listening = <S extends Server | ReturnType<typeof createTcpServer>>(server: S) =>
  new Promise<S>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });

const portOf = (server: { address: () => unknown }): number =>
  (server.address() as AddressInfo).port;

export async function startNetwork(): Promise<Network> {
  const tunnels: string[] = [];
  let connections = 0;
  const target = createTcpServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  const proxy = createHttpServer().on("connect", (request, socket) => {
    const to = request.url ?? "";
    tunnels.push(to);
    const [host = "", port = "0"] = to.split(/:(?=\d+$)/u);
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await Promise.all([listening(target), listening(proxy)]);
  return {
    tunnels,
    targetConnections: () => connections,
    targetPort: portOf(target),
    proxyUrl: `http://127.0.0.1:${String(portOf(proxy))}`,
    reset: () => {
      tunnels.length = 0;
      connections = 0;
    },
    close: async () => {
      await Promise.all(
        [target, proxy].map((server) => new Promise((resolve) => server.close(resolve))),
      );
    },
  };
}
