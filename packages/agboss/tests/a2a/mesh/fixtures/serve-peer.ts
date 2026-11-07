import { createServer, type Server } from "node:http";
import { a2aHttpListener } from "../../../../src/a2a/a2a-http.js";
import { createApp } from "../../../../src/application/create-app.js";
import type { App } from "../../../../src/app/types.js";
import type { Clock } from "../../../../src/index.js";
import { BudgetScope } from "../../../../src/budgets/budget.js";
import { CostLedgerRepository } from "../../../../src/infrastructure/cost-ledger.repository.js";
import { caller } from "./caller/caller.application.js";
import {
  peer,
  PeerA2AExpose,
  PeerApplication,
  PeerCallerResolver,
  type EndLosingPeerApplication,
  type KeylessPeerApplication,
  type StrictPeerApplication,
} from "./peer/peer.application.js";

/** A served peer: its app, where it listens (loopback), and how to stop both. */
export interface ServedPeer {
  readonly app: App;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

/**
 * #810 — the peer application built with `createApp` on the test's clock and served by the real
 * `a2aHttpListener` on `127.0.0.1` (its card's interface at `http://peer.test/a2a`, where the
 * caller's routing sends it); the caller routed to it.
 */
export async function servePeer(
  clock: Clock,
  Peer:
    | typeof PeerApplication
    | typeof StrictPeerApplication
    | typeof KeylessPeerApplication
    | typeof EndLosingPeerApplication = PeerApplication,
): Promise<ServedPeer> {
  peer.clock = clock;
  const app = await createApp(Peer, { env: "test" });
  const listener = a2aHttpListener(app, {
    expose: PeerA2AExpose,
    callerResolver: PeerCallerResolver,
    publicUrl: "http://peer.test",
    base: "/a2a",
  });
  const server: Server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const origin = `http://127.0.0.1:${String(port)}`;
  caller.origin = origin;
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await app.close();
  };
  return { app, origin, close };
}

/** What the ledger holds for one execution's budget (`test-execution-budget`, no period). */
export const executionSpentOf = (
  app: Pick<App, "resolve">,
  rootExecutionId: string,
): Promise<number> =>
  app.resolve(CostLedgerRepository).findSpentByCounter({
    budget: "test-execution-budget",
    scope: BudgetScope.Execution,
    key: rootExecutionId,
    period: "",
  });
