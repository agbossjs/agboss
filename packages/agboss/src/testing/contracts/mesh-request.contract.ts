import { expect } from "vitest";
import type {
  MeshRequestKey,
  MeshRequestRecord,
  MeshRequestRepository,
} from "../../infrastructure/mesh-request.repository.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import type { ContractTarget } from "./seam.js";

const key: MeshRequestKey = {
  tenantId: "default",
  peer: "orders-application",
  idempotencyKey: "e1:desk:1:call_1",
};
const at = (iso: string, of: MeshRequestKey = key): MeshRequestRecord => ({
  ...of,
  createdAt: iso,
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
    name: "the sweep removes the requests admitted before its cutoff only",
    run: async ({ first, second }) => {
      const late = { ...key, idempotencyKey: "late" };
      await first.saveIfAbsent(at(NINE));
      await first.saveIfAbsent(at("2026-01-05T09:40:00.000Z", late));

      await second.deleteCreatedBefore(new Date("2026-01-05T09:30:00.000Z"));

      expect(await first.findByKey(key)).toBeUndefined();
      expect(await first.findByKey(late)).toBeDefined();
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
