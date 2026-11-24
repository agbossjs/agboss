/**
 * #1366 (shard once-mesh) — a trusted MCP call runs once (#398 PR 2b): `dedupedMcpCall` keeps it by
 * (tenant, peer, call id), answers a repeat from the store, answers one that comes while the first
 * still runs with `mesh.request-in-progress`, and forgets a call that threw. Each rule on its own, with
 * a store that says what it was asked.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { App } from "../../src/app/types.js";
import {
  InMemoryMeshRequestRepository,
  MeshRequestRepository,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "../../src/infrastructure/mesh-request.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { dedupedMcpCall, type McpDedupeCall } from "../../src/mcp/mcp-dedupe.js";
import { rememberMeshSettings } from "../../src/mesh/mesh-settings.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../../src/mesh/mesh-verification.js";
import { VirtualClock } from "../../src/testing/index.js";

const NOW = new Date("2026-11-20T10:00:00.000Z");

/** A store that lists each operation it was asked, with the key. */
class ListedRequests extends InMemoryMeshRequestRepository {
  readonly asked: string[] = [];
  readonly saved: MeshRequestRecord[] = [];

  constructor() {
    super(new InMemoryDatabase());
  }

  override saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    this.asked.push("saveIfAbsent");
    this.saved.push(record);
    return super.saveIfAbsent(record);
  }

  override findByKey(key: MeshRequestKey) {
    this.asked.push("findByKey");
    return super.findByKey(key);
  }

  override saveResponse(key: MeshRequestKey, response: unknown) {
    this.asked.push("saveResponse");
    return super.saveResponse(key, response);
  }

  override deleteByKey(key: MeshRequestKey) {
    this.asked.push("deleteByKey");
    return super.deleteByKey(key);
  }
}

function appOf(requests: MeshRequestRepository, hasSettings = true): App {
  const app = {
    resolve: (type: unknown) => {
      if (type !== MeshRequestRepository) throw new Error("only the request store is resolved");
      return requests;
    },
  };
  rememberMeshSettings(app, () =>
    hasSettings
      ? ({ clock: new VirtualClock(NOW), idempotencyRetention: 60_000 } as never)
      : undefined,
  );
  return app as never;
}

const TRUSTED: McpDedupeCall = {
  tool: "order-status-tool",
  args: { orderId: "7" },
  peer: "orders-app",
  callId: "c-1",
  tenantId: "acme",
};
const result = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** A run that counts itself and answers `text`. */
const counting = (text = "paid") => {
  const runs = { count: 0 };
  return {
    runs,
    run: () => {
      runs.count += 1;
      return Promise.resolve(result(`${text} ${String(runs.count)}`));
    },
  };
};

describe("#1366: a trusted MCP call runs once", () => {
  it("keeps the call before it runs, then its result, dated by the application's clock; the caller gets the result", async () => {
    const requests = new ListedRequests();
    const { run, runs } = counting();

    const first = await dedupedMcpCall(appOf(requests), TRUSTED, run);

    expect(first).toEqual(result("paid 1"));
    expect(runs.count).toBe(1);
    expect(requests.asked).toEqual(["saveIfAbsent", "saveResponse"]);
    expect(requests.saved).toEqual([
      {
        tenantId: "acme",
        peer: "orders-app",
        idempotencyKey: "c-1",
        tool: "order-status-tool",
        requestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      },
    ]);
    expect(
      await requests.findByKey({ tenantId: "acme", peer: "orders-app", idempotencyKey: "c-1" }),
    ).toMatchObject({ response: result("paid 1") });
  });

  it("answers a repeat with the kept result, and runs nothing again", async () => {
    const requests = new ListedRequests();
    const app = appOf(requests);
    const { run, runs } = counting();

    const first = await dedupedMcpCall(app, TRUSTED, run);
    const second = await dedupedMcpCall(app, TRUSTED, run);
    const third = await dedupedMcpCall(app, TRUSTED, run);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(runs.count).toBe(1);
  });

  it("refuses a repeat of the key that asks another tool or other arguments: mesh.idempotency-key-reused, and runs nothing", async () => {
    const app = appOf(new ListedRequests());
    const { run, runs } = counting();
    await dedupedMcpCall(app, TRUSTED, run);

    const otherArgs = await dedupedMcpCall(app, { ...TRUSTED, args: { orderId: "8" } }, run);
    const otherTool = await dedupedMcpCall(app, { ...TRUSTED, tool: "refund-tool" }, run);
    const sameAgain = await dedupedMcpCall(app, { ...TRUSTED, args: { orderId: "7" } }, run);

    for (const refused of [otherArgs, otherTool])
      expect(refused).toMatchObject({
        isError: true,
        _meta: { "agboss.dev/error": { code: "mesh.idempotency-key-reused" } },
      });
    expect(sameAgain).toEqual(result("paid 1"));
    expect(runs.count).toBe(1);
  });

  it("answers a repeat while the first still runs: mesh.request-in-progress, and runs nothing", async () => {
    const requests = new ListedRequests();
    const app = appOf(requests);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = counting();
    const first = dedupedMcpCall(app, TRUSTED, async () => {
      await held;
      return slow.run();
    });
    await Promise.resolve();
    await Promise.resolve();

    const repeat = await dedupedMcpCall(app, TRUSTED, slow.run);

    const code = MeshRefusalCode.RequestInProgress;
    expect(repeat).toEqual({
      content: [{ type: "text", text: `Error: ${MESH_REFUSAL_TEXT[code]}` }],
      isError: true,
      _meta: {
        "agboss.dev/error": { code: "mesh.request-in-progress", error: MESH_REFUSAL_TEXT[code] },
      },
    });
    expect(slow.runs.count).toBe(0);
    release();
    expect(await first).toEqual(result("paid 1"));
    expect(requests.asked.filter((asked) => asked === "saveResponse")).toHaveLength(1);
  });

  it("answers a repeat whose kept row is gone as in progress, not as an answer", async () => {
    const requests = new ListedRequests();
    requests.saveIfAbsent = () => Promise.resolve(false);

    const repeat = await dedupedMcpCall(appOf(requests), TRUSTED, counting().run);

    expect(repeat.isError).toBe(true);
    expect(repeat._meta).toMatchObject({
      "agboss.dev/error": { code: "mesh.request-in-progress" },
    });
  });

  it("forgets a call that threw, rethrows its error, and runs the next try", async () => {
    const requests = new ListedRequests();
    const app = appOf(requests);
    const failure = new Error("the desk is closed");

    await expect(dedupedMcpCall(app, TRUSTED, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(requests.asked).toEqual(["saveIfAbsent", "deleteByKey"]);
    expect(
      await requests.findByKey({ tenantId: "acme", peer: "orders-app", idempotencyKey: "c-1" }),
    ).toBeUndefined();
    const again = counting();
    expect(await dedupedMcpCall(app, TRUSTED, again.run)).toEqual(result("paid 1"));
  });

  it("keeps a call by its tenant, its peer and its call id: any other runs again", async () => {
    const app = appOf(new ListedRequests());
    const { run, runs } = counting();

    await dedupedMcpCall(app, TRUSTED, run);
    await dedupedMcpCall(app, { ...TRUSTED, tenantId: "globex" }, run);
    await dedupedMcpCall(app, { ...TRUSTED, peer: "billing-app" }, run);
    await dedupedMcpCall(app, { ...TRUSTED, callId: "c-2" }, run);

    expect(runs.count).toBe(4);
  });

  it("a call of no tenant is kept under the default tenant", async () => {
    const requests = new ListedRequests();

    await dedupedMcpCall(appOf(requests), { ...TRUSTED, tenantId: undefined }, counting().run);

    expect(requests.saved[0]?.tenantId).toBe("default");
  });
});

describe("#1366: a call that is never deduplicated", () => {
  const runsEach = async (call: McpDedupeCall, hasSettings = true) => {
    const requests = new ListedRequests();
    const app = appOf(requests, hasSettings);
    const { run, runs } = counting();

    const first = await dedupedMcpCall(app, call, run);
    const second = await dedupedMcpCall(app, call, run);

    expect([first, second]).toEqual([result("paid 1"), result("paid 2")]);
    expect(runs.count).toBe(2);
    expect(requests.asked).toEqual([]);
  };

  it("one of no trusted peer", () => runsEach({ ...TRUSTED, peer: undefined }));

  it("one with no call id", () => runsEach({ ...TRUSTED, callId: undefined }));

  it("one of a tenant whose id is no key's text: it runs, and its execution refuses it", async () => {
    await runsEach({ ...TRUSTED, tenantId: "t\uD800" });
    await runsEach({ ...TRUSTED, tenantId: "" });
  });

  it("one of an application with no mesh settings", () => runsEach(TRUSTED, false));
});
