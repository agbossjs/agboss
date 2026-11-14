import { callKeyOf } from "./calls.js";
import { expectEqual, live, type ForcedRace } from "./races.js";
import type { ExplorerRun } from "./run.js";
import { onKey, ownerOf, raceIntent, recorded, moveBy, rowsOf, writeBy } from "./store-races.js";
import { EXPLORED_TENANT, ExplorerWorldKind } from "./types.js";

/**
 * The races of a tree's cancel with the fencing stores' writes (#909), each in both orders: the
 * write or the send invoked before the cancel answered lands, the one invoked after it is refused
 * (`"cancelled"`), and what ends an attempt claimed before is accepted in both.
 */

/** The tree's cancel request (#909) asked by `instance`: answered `"cancel"` once durable. */
const cancelBy = (run: ExplorerRun, instance: number, tree = "tree-1"): Promise<unknown> =>
  run
    .storesOf(instance)
    .leases.requestCancel({ tenantId: EXPLORED_TENANT, rootExecutionId: tree })
    .then(() => "cancel");

/** The fenced effect's race with the cancel. */
export const CANCEL_EFFECT_RACES: readonly ForcedRace[] = [
  {
    name: "a write against its tree's cancel (#909): the write before it lands, the write after it is refused",
    kind: ExplorerWorldKind.FencedEffect,
    setup: live,
    first: (run, { lease }) => writeBy(run, 1, lease.token),
    second: (run) => cancelBy(run, 2),
    firstWins: async ({ first, second }, run) =>
      expectEqual("the write", first, "ran") ??
      expectEqual("the cancel", second, "cancel") ??
      expectEqual("the rows", await rowsOf(run), 1),
    secondWins: async ({ first, second }, run) =>
      expectEqual("the write", first, "cancelled") ??
      expectEqual("the cancel", second, "cancel") ??
      expectEqual("the rows", await rowsOf(run), 0),
  },
];

/** The outbound call's races with the cancel. */
export const CANCEL_CALL_RACES: readonly ForcedRace[] = [
  {
    name: "a new intent against its tree's cancel (#909): recorded before it, refused after it",
    kind: ExplorerWorldKind.OutboundCall,
    setup: live,
    first: (run, { lease }) =>
      onKey(run, 1, lease).calls.saveIfAbsent(
        callKeyOf("tree-1", lease.token),
        raceIntent("tree-1"),
      ),
    second: (run) => cancelBy(run, 2),
    firstWins: async ({ first, second }, run, { lease }) =>
      expectEqual("the save", first, true) ??
      expectEqual("the cancel", second, "cancel") ??
      expectEqual("the owner", await ownerOf(run, lease), `owner-tree-1`),
    secondWins: async ({ first, second }, run, { lease }) =>
      expectEqual("the save", first, "cancelled") ??
      expectEqual("the cancel", second, "cancel") ??
      expectEqual("the intent", await ownerOf(run, lease), undefined),
  },
  {
    name: "a claim of the next attempt against its tree's cancel (#909): claimed before it, refused after it",
    kind: ExplorerWorldKind.OutboundCall,
    setup: recorded,
    first: (run, { lease }) => moveBy(run, 1, lease),
    second: (run) => cancelBy(run, 2),
    firstWins: async ({ first, second }, run, { lease }) =>
      expectEqual("the claim", first, true) ??
      expectEqual("the cancel", second, "cancel") ??
      expectEqual("the owner", await ownerOf(run, lease), "owner-1-2"),
    secondWins: async ({ first, second }, run, { lease }) =>
      expectEqual("the claim", first, "cancelled") ??
      expectEqual("the cancel", second, "cancel") ??
      expectEqual("the owner", await ownerOf(run, lease), "owner-1"),
  },
  {
    name: "the end of an attempt claimed before the cancel, against the cancel (#909): recorded in both orders",
    kind: ExplorerWorldKind.OutboundCall,
    setup: recorded,
    first: (run, { lease }) =>
      onKey(run, 1, lease).calls.markCompleted(
        callKeyOf("tree-1", lease.token),
        "owner-1",
        '"paid"',
      ),
    second: (run) => cancelBy(run, 2),
    firstWins: ({ first, second }) =>
      Promise.resolve(
        expectEqual("the end", first, true) ?? expectEqual("the cancel", second, "cancel"),
      ),
    secondWins: ({ first, second }) =>
      Promise.resolve(
        expectEqual("the end", first, true) ?? expectEqual("the cancel", second, "cancel"),
      ),
  },
];
