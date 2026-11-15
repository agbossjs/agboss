/**
 * #1138: a file fetch's request is made on the module's own agent, pinned to the address the
 * guarded resolver allowed — a replaced `http.ClientRequest` that hands it to another agent (it
 * drops `createConnection` and `agent`, so Node falls back to `http.globalAgent`, or it assigns
 * `http.globalAgent` itself) makes no second lookup and no TCP connection to the rebound, denied
 * address, and the refused request's socket is destroyed, never pooled. Each case is a child process
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
  lookups: number;
  connects: string[];
  blocked: number;
  pooled: number;
  lingering: boolean;
}

async function fetchedUnder(mode: string, answers = "rebind", path = "/a.pdf"): Promise<Report> {
  const result = await runNodeReporting(
    [
      "--import",
      "tsx",
      CHILD,
      `https://${HOST}:${String(trap.targetPort)}${path}`,
      mode,
      String(vhost.port),
      answers,
    ],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: vhost.trust } },
  );
  if (result.status !== 0) throw new Error(`the child failed:\n${result.stderr}`);
  return {
    ...(result.messages[0] as Omit<Report, "lingering">),
    lingering: result.messages.length > 1,
  };
}

/** The fetch's own connection only: one TCP connect, to the allowed address, nothing at the trap. */
function expectOnlyTheAllowedPeer(fetched: Report): void {
  expect(fetched.blocked).toBe(0);
  expect(fetched.lookups).toBe(1);
  expect(fetched.connects).toEqual([`93.184.216.34:${String(trap.targetPort)}`]);
  expect(trap.targetConnections()).toBe(0);
  expect(trap.targetBytes()).toBe(0);
  expect(vhost.connections()).toBe(1);
  expect(fetched.pooled).toBe(0);
  expect(fetched.lingering).toBe(false);
}

describe("#1138 AC1: a request handed to another agent touches no other peer", () => {
  it("C0 control: no replacement, the file is fetched over the one checked connection", async () => {
    const fetched = await fetchedUnder("none");

    expect(fetched.outcome).toBe("fetched");
    expectOnlyTheAllowedPeer(fetched);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);

  it("AC1 a dropped createConnection: the request stays on its own agent, fetched, nothing at the trap", async () => {
    const fetched = await fetchedUnder("drop-create-connection");

    expect(fetched.outcome).toBe("fetched");
    expectOnlyTheAllowedPeer(fetched);
    expect(vhost.requests).toEqual(["/a.pdf"]);
  }, 30_000);

  it("AC1 dropped agent and createConnection (http.globalAgent): denied, no second lookup, no connection", async () => {
    const fetched = await fetchedUnder("drop-agent");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expectOnlyTheAllowedPeer(fetched);
    expect(vhost.requests).toEqual([]);
  }, 30_000);

  it("AC1 an assigned http.globalAgent: denied, no second lookup, no connection", async () => {
    const fetched = await fetchedUnder("global-agent");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expectOnlyTheAllowedPeer(fetched);
    expect(vhost.requests).toEqual([]);
  }, 30_000);

  it("AC1 an assigned http.globalAgent, stable answers: denied, nothing pooled, the child exits", async () => {
    const fetched = await fetchedUnder("global-agent", "stable");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expectOnlyTheAllowedPeer(fetched);
    expect(vhost.requests).toEqual([]);
  }, 30_000);

  it("AC1 http.globalAgent without the pinned lookup and local address: its connect goes only to the allowed address and is destroyed", async () => {
    const fetched = await fetchedUnder("global-agent-bare");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(fetched.blocked).toBe(0);
    expect(fetched.lookups).toBe(1);
    // at most the agent's own connect, to the checked address — never the rebound one
    expect(new Set(fetched.connects)).toEqual(
      new Set([`93.184.216.34:${String(trap.targetPort)}`]),
    );
    expect(trap.targetConnections()).toBe(0);
    expect(fetched.pooled).toBe(0);
    expect(fetched.lingering).toBe(false);
    expect(vhost.requests).toEqual([]);
  }, 30_000);

  it("AC2 limit: a replacement that also sets the url's name back looks it up again, but connects nowhere", async () => {
    const fetched = await fetchedUnder("global-agent-name");

    expect(fetched.outcome).toBe("a2a.file-address-denied");
    expect(fetched.blocked).toBe(0);
    expect(fetched.lookups).toBe(2);
    expect(fetched.connects).toEqual([`93.184.216.34:${String(trap.targetPort)}`]);
    expect(trap.targetConnections()).toBe(0);
    expect(fetched.pooled).toBe(0);
    expect(fetched.lingering).toBe(false);
  }, 30_000);
});

describe("#1021 guarantees the acceptance found unprotected", () => {
  it("G2 an error emitted on the request destroys the TLS socket: no HTTP byte, the child exits", async () => {
    const fetched = await fetchedUnder("request-error");

    expect(fetched.outcome).toBe("failed");
    expect(vhost.requests).toEqual([]);
    expect(fetched.lingering).toBe(false);
  }, 30_000);
});
