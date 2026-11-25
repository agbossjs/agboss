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
const at = (
  iso: string,
  of: MeshRequestKey = key,
  attemptId = "attempt-1",
  hash = "sha256:aa",
): MeshRequestRecord => ({
  ...of,
  tool: "order-status-tool",
  requestHash: hash,
  attemptId,
  createdAt: iso,
  expiresAt: new Date(Date.parse(iso) + 30 * 60_000).toISOString(),
  lockedUntil: new Date(Date.parse(iso) + 30_000).toISOString(),
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

      await first.saveResponse(key, "attempt-1", {
        status: "finished",
        output: { text: "paid" },
      });
      await first.deleteByKey(other, "attempt-1");

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

      await first.saveResponse(key, "attempt-1", response);

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
        attemptId: "attempt-1",
        createdAt: NINE,
        expiresAt: "2026-01-05T09:30:00.000Z",
        lockedUntil: "2026-01-05T09:00:30.000Z",
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
      await first.saveResponse(key, "attempt-1", { status: "finished" });
      await first.saveIfAbsent(at("2026-01-05T09:40:00.000Z", late));
      await first.saveResponse(late, "attempt-1", { status: "finished" });

      expect(await second.deleteExpired(new Date("2026-01-05T09:29:59.999Z"))).toBe(0);
      expect(await second.deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).toBe(1);

      expect(await first.findByKey(key)).toBeUndefined();
      expect(await first.findByKey(late)).toBeDefined();
    },
  },
  {
    name: "a running request is held by its attempt: a live lease keeps the key, a lapsed one lets the same call take it over",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(at(NINE));

      // inside the lease: a repeat (the same call or any) does not get the key
      expect(await second.saveIfAbsent(at("2026-01-05T09:00:29.999Z", key, "attempt-2"))).toBe(
        false,
      );
      expect((await second.findByKey(key))?.attemptId).toBe("attempt-1");
      // once it lapsed: the same call (tool and hash) takes it over, another request does not
      expect(
        await second.saveIfAbsent(at("2026-01-05T09:00:30.000Z", key, "attempt-2", "sha256:bb")),
      ).toBe(false);
      expect(await second.saveIfAbsent(at("2026-01-05T09:00:30.000Z", key, "attempt-2"))).toBe(
        true,
      );
      expect((await first.findByKey(key))?.attemptId).toBe("attempt-2");
    },
  },
  {
    name: "a handler that keeps renewing its lease is never reclaimed, and the sweep leaves its row",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(at(NINE));

      expect(await first.renewLease(key, "attempt-1", "2026-01-05T10:00:00.000Z")).toBe(true);

      expect(await second.saveIfAbsent(at("2026-01-05T09:59:59.999Z", key, "attempt-2"))).toBe(
        false,
      );
      expect(await second.deleteExpired(new Date("2026-01-05T09:59:59.999Z"))).toBe(0);
      expect((await second.findByKey(key))?.attemptId).toBe("attempt-1");
    },
  },
  {
    name: "a dead handler's request is swept once its window and its lease have both lapsed",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(at(NINE));

      // the lease lapsed but the replay window (30 minutes) has not: the row stays
      expect(await second.deleteExpired(new Date("2026-01-05T09:29:59.999Z"))).toBe(0);
      expect(await second.deleteExpired(new Date("2026-01-05T09:30:00.000Z"))).toBe(1);
      expect(await first.findByKey(key)).toBeUndefined();
    },
  },
  {
    name: "a stale handler after a takeover can neither answer, renew nor forget: fenced, nothing written",
    run: async ({ first, second }) => {
      await first.saveIfAbsent(at(NINE));
      await second.saveIfAbsent(at("2026-01-05T09:01:00.000Z", key, "attempt-2"));

      expect(await first.saveResponse(key, "attempt-1", { status: "stale" })).toBe(false);
      expect(await first.renewLease(key, "attempt-1", "2026-01-05T11:00:00.000Z")).toBe(false);
      expect(await first.deleteByKey(key, "attempt-1")).toBe(false);

      const kept = await second.findByKey(key);
      expect(kept?.attemptId).toBe("attempt-2");
      expect(kept?.response).toBeUndefined();
      expect(await second.saveResponse(key, "attempt-2", { status: "finished" })).toBe(true);
      expect(await first.saveResponse(key, "attempt-1", { status: "late" })).toBe(false);
      expect((await first.findByKey(key))?.response).toEqual({ status: "finished" });
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
