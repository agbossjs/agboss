import type { App } from "../../app/types.js";
import { lazyLoad } from "../../infrastructure/clock.js";
import type { FaultStoreSet } from "./fault-stores.js";
import { FaultA2AExpose, FaultCallerResolver, keepsA2ATasks } from "./fixture/fault.a2a.js";

/**
 * A fault pod's A2A listener (#811 AC4): on a store set that keeps A2A tasks, the pod serves the
 * fixture's expose with `a2aHttpListener` on a free loopback port — its URL in the pod's `ready`
 * event, what a scenario sends its messages to. A set without A2A tasks serves none: `undefined`.
 */

const LOOPBACK = "127.0.0.1";

/** The pod's listener: its JSON-RPC endpoint. */
export interface PodA2AListener {
  readonly url: string;
}

/** Serves `app` over A2A when `stores` keep A2A tasks; the listener's URL, else `undefined`. */
export async function podA2AListenerOf(
  app: App,
  stores: FaultStoreSet,
): Promise<PodA2AListener | undefined> {
  if (!keepsA2ATasks(stores.providers)) return undefined;
  const [{ createServer }, { a2aHttpListener }] = await Promise.all([
    lazyLoad(import("node:http")),
    lazyLoad(import("../../a2a/a2a-http.js")),
  ]);
  // the port is known once it listens: the listener is built then, before its first request
  const listening: { handle?: ReturnType<typeof a2aHttpListener> } = {};
  const server = createServer((request, response) => {
    if (listening.handle !== undefined) {
      listening.handle(request, response);
      return;
    }
    // a request before the listener is built: not served yet, never left hanging
    response.writeHead(503).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error(`the pod's A2A listener has no TCP address: ${String(address)}`);
  const url = `http://${LOOPBACK}:${String(address.port)}`;
  listening.handle = a2aHttpListener(app, {
    expose: FaultA2AExpose,
    callerResolver: FaultCallerResolver,
    publicUrl: url,
  });
  // the pod's process ends with its pods: the server never keeps it alive
  server.unref();
  return { url };
}
