import { expect } from "vitest";
import type {
  MeshRequestKey,
  MeshRequestRecord,
  MeshRequestRepository,
} from "../../infrastructure/mesh-request.repository.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import type { ContractTarget } from "./instance-context.js";

const key: MeshRequestKey = {
  tenantId: "default",
  peer: "orders-application",
  idempotencyKey: "e1:desk:1:call_1",
};
/** A request admitted at `iso`, kept for `minutes` (30 by default). */
const at = (iso: string, of: MeshRequestKey = key, minutes = 30): MeshRequestRecord => ({
  ...of,
  tool: "order-status-tool",
  requestHash: "sha256:aa",
  createdAt: iso,
  expiresAt: new Date(Date.parse(iso) + minutes * 60_000).toISOString(),
});
const NINE = "2026-01-05T09:00:00.000Z";

const MESH_CASES: readonly ContractCase<MeshRequestRepository>[] = [
  {
    name: "one save of a key wins, on two instances",
    run: async ({ first, second }) => {
      const saved = await Promise.all([
        first.saveIfAbsent(at(NINE)),
        second.saveIfAbsent(at(NINE)),
      ]);

      expect(saved.filter(Boolean)).toHaveLength(1);
      expect(await second.findByKey(key)).toEqual(at(NINE));
    },
  },
  {
    name: "a key is the tenant's and the peer's: another one finds nothing",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(at(NINE));

      expect(await second.findByKey({ ...key, peer: "elsewhere-application" })).toBeUndefined();
      expect(await second.findByKey({ ...key, tenantId: "acme" })).toBeUndefined();
    },
  },
  {
    name: "an answer is kept for the key; a request without one is forgotten",
    run: async ({ first, second }) => {
      const other = { ...key, idempotencyKey: "e1:desk:1:call_2" };
      await first.saveIfAbsent(at(NINE));
      await first.saveIfAbsent(at(NINE, other));

      await first.saveResponse(key, { status: "finished", output: { text: "paid" } });
      await first.deleteByKey(other);

      expect((await second.findByKey(key))?.response).toEqual({
        status: "finished",
        output: { text: "paid" },
      });
      expect(await second.findByKey(other)).toBeUndefined();
      expect(await second.saveIfAbsent(at("2026-01-05T09:01:00.000Z", other))).toBe(true);
    },
  },
  {
    name: nulCaseName("an answer"),
    run: async ({ first, second }) => {
      const response = { status: "finished", output: { text: NUL_TEXT } };
      await first.saveIfAbsent(at(NINE));

      await first.saveResponse(key, response);

      expect((await second.findByKey(key))?.response).toEqual(response);
    },
  },
  {
    name: "the request keeps its tool, its request hash and its expiry",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(at(NINE));

      expect(await second.findByKey(key)).toEqual({
        ...key,
        tool: "order-status-tool",
        requestHash: "sha256:aa",
        createdAt: NINE,
        expiresAt: "2026-01-05T09:30:00.000Z",
      });
    },
  },
  {
    name: "a record saved with its answer keeps it; it is swept once it has expired",
    run: async ({ first, second }) => {
      await first.saveIfAbsent({ ...at(NINE), response: true });

      expect((await second.findByKey(key))?.response).toBe(true);
      expect(await second.deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).toBe(1);
      expect(await first.findByKey(key)).toBeUndefined();
    },
  },
  {
    name: "the sweep removes the answered requests whose expiry has come, and only those",
    run: async ({ first, second }) => {
      const late = { ...key, idempotencyKey: "late" };
      await first.saveIfAbsent(at(NINE));
      await first.saveResponse(key, { status: "finished" });
      await first.saveIfAbsent(at("2026-01-05T09:40:00.000Z", late));
      await first.saveResponse(late, { status: "finished" });

      expect(await second.deleteExpired(new Date("2026-01-05T09:29:59.999Z"))).toBe(0);
      expect(await second.deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).toBe(1);

      expect(await first.findByKey(key)).toBeUndefined();
      expect(await first.findByKey(late)).toBeDefined();
    },
  },
  {
    name: "a request still running keeps its key inside its window and the grace after it; a crashed one is reclaimable after",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(at(NINE));

      // the window (30 minutes) has passed, the grace (1 hour) has not: the key is still taken
      expect(await second.deleteExpired(new Date("2026-01-05T10:29:59.999Z"))).toBe(0);
      expect(await second.saveIfAbsent(at("2026-01-05T10:29:59.999Z"))).toBe(false);
      expect((await second.findByKey(key))?.response).toBeUndefined();

      // past the window and the grace: swept, and the key may be taken again
      expect(await second.deleteExpired(new Date("2026-01-05T10:30:00.000Z"))).toBe(1);
      expect(await second.saveIfAbsent(at("2026-01-05T10:30:00.000Z"))).toBe(true);
    },
  },
];

/**
 * `MeshRequestRepository` (#398 PR 2): the trusted mesh requests' answers by their key. One save of
 * a key wins, even on two instances; a key is scoped by tenant and peer; an answer is kept, a
 * request without one forgotten; the sweep removes what is older than its cutoff.
 */
export function meshRequestContract(target: ContractTarget<MeshRequestRepository>): void {
  registerContract("mesh request contract", target, [{ cases: MESH_CASES }], pingOf);
}
