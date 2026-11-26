import { expect } from "vitest";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { expiringPauseOf } from "./paused-execution-data.js";

/** #1307e: the listing's filters (assignee, external reference) and its look across tenants. */
type Instances = ContractInstances<PausedExecutionRepository>;
type Filter = Parameters<PausedExecutionRepository["findPageByTenantId"]>[1];
const ids = (pauses: readonly PauseRecord[]): readonly string[] =>
  pauses.map((pause) => pause.pauseId);
const pending = [PauseStatus.Pending];

/** Pause `id` of `tenant`, with who has it and the reference its channel gave it. */
const listedPause = (
  id: string,
  tenant: string,
  held: {
    readonly assignees?: readonly string[];
    readonly externalRef?: string;
    readonly channel?: string;
  },
): PauseRecord => ({
  ...expiringPauseOf(id, `${tenant}:${id}:1`),
  tenantId: tenant,
  ...held,
});

/** Three pauses of `default` and one of `acme`, as the cases below read them. */
async function seeded(store: PausedExecutionRepository): Promise<void> {
  await store.findOrCreateByStepKey(
    listedPause("p1", "default", { assignees: ["ann", "bob"], externalRef: "JIRA-1" }),
  );
  await store.findOrCreateByStepKey(
    listedPause("p2", "default", { assignees: ["bob"], externalRef: "JIRA-2" }),
  );
  await store.findOrCreateByStepKey(listedPause("p3", "default", { channel: "other-channel" }));
  await store.findOrCreateByStepKey(
    listedPause("p4", "acme", { assignees: ["ann"], externalRef: "JIRA-1" }),
  );
}

export const LIST_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "findPageByTenantId filters assignee (any of a pool) and externalRef, alone and together, never another tenant's",
    run: async ({ first, second }: Instances): Promise<void> => {
      await seeded(first);
      const of = async (filter: Partial<Filter>): Promise<readonly string[]> =>
        ids(
          (await second.findPageByTenantId("default", { statuses: pending, ...filter }, 10)).pauses,
        );

      expect(await of({ assignee: "bob" })).toEqual(["p1", "p2"]);
      expect(await of({ assignee: "ann" })).toEqual(["p1"]);
      expect(await of({ assignee: "nobody" })).toEqual([]);
      expect(await of({ externalRef: "JIRA-1" })).toEqual(["p1"]);
      expect(await of({ externalRef: "JIRA-3" })).toEqual([]);
      expect(await of({ assignee: "bob", externalRef: "JIRA-2" })).toEqual(["p2"]);
      expect(await of({ assignee: "ann", externalRef: "JIRA-2" })).toEqual([]);
      expect(await of({})).toEqual(["p1", "p2", "p3"]);
    },
  },
  {
    name: "findPageByTenantId and findPageOfAllTenants filter channel (the name), alone and with other filters",
    run: async ({ first, second }: Instances): Promise<void> => {
      await seeded(first);
      const of = async (filter: Partial<Filter>): Promise<readonly string[]> =>
        ids(
          (await second.findPageByTenantId("default", { statuses: pending, ...filter }, 10)).pauses,
        );

      expect(await of({ channel: "other-channel" })).toEqual(["p3"]);
      expect(await of({ channel: "refund-approval-channel" })).toEqual(["p1", "p2"]);
      expect(await of({ channel: "refund-approval-channel", assignee: "ann" })).toEqual(["p1"]);
      expect(await of({ channel: "no-such-channel" })).toEqual([]);
      const all = await second.findPageOfAllTenants(
        { statuses: pending, channel: "refund-approval-channel" },
        10,
      );
      expect(ids(all.pauses)).toEqual(["p1", "p2", "p4"]);
    },
  },
  {
    name: "findPageByTenantId pages a filtered listing once each; a filter that leaves one page leaves no cursor",
    run: async ({ first, second }: Instances): Promise<void> => {
      await seeded(first);
      const filter: Filter = { statuses: pending, assignee: "bob" };

      const one = await second.findPageByTenantId("default", filter, 1);
      const two = await second.findPageByTenantId("default", filter, 1, one.next);

      expect(ids(one.pauses)).toEqual(["p1"]);
      expect(one.next).toBeTypeOf("string");
      expect(ids(two.pauses)).toEqual(["p2"]);
      expect(two.next).toBeUndefined();
    },
  },
  {
    name: "findPageOfAllTenants lists every tenant's pauses in the insertion order, filtered and paged, each once",
    run: async ({ first, second }: Instances): Promise<void> => {
      await seeded(first);
      const all = async (filter: Partial<Filter>, limit = 10, after?: string) =>
        second.findPageOfAllTenants({ statuses: pending, ...filter }, limit, after);

      expect(ids((await all({})).pauses)).toEqual(["p1", "p2", "p3", "p4"]);
      expect(ids((await all({ externalRef: "JIRA-1" })).pauses)).toEqual(["p1", "p4"]);
      expect(ids((await all({ assignee: "ann" })).pauses)).toEqual(["p1", "p4"]);
      const one = await all({}, 3);
      const two = await all({}, 3, one.next);
      expect([...ids(one.pauses), ...ids(two.pauses)]).toEqual(["p1", "p2", "p3", "p4"]);
      expect(two.next).toBeUndefined();
      await expect(second.findPageOfAllTenants({ statuses: [] }, 10)).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(second.findPageOfAllTenants({ statuses: pending }, 0)).rejects.toBeInstanceOf(
        RangeError,
      );
    },
  },
  {
    name: "findPageByTenantId lists the tenant's pauses only: of every tenant's, another's never appears",
    run: async ({ first, second }: Instances): Promise<void> => {
      await seeded(first);

      expect(
        ids((await second.findPageByTenantId("acme", { statuses: pending }, 10)).pauses),
      ).toEqual(["p4"]);
      expect(
        ids((await second.findPageByTenantId("ghost", { statuses: pending }, 10)).pauses),
      ).toEqual([]);
    },
  },
];
