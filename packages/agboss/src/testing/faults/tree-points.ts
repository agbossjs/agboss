import type { ExecutionTree } from "../../infrastructure/execution-tree.repository.js";
import { StoreHoldPoint, type StoreMethod } from "./store-points.js";

/**
 * The tree store's hold point (#607): `saveIfAbsentInTree`, the write of a tree's shared key — the
 * framework's marks among them (`@agboss/unwinding`, an undo's done mark `@agboss/compensated/…`,
 * a child's failure claim). A hold matches a key's family, the framework's prefix
 * (`@agboss/compensated`), so a scenario holds the first done mark of its tree without knowing the
 * step key; a project's own key is its own family. The history keeps the tree and the family, never
 * a value.
 */

/** The family of a tree key: `@agboss/<name>` for the framework's, else the key itself. */
export const treeKeyFamilyOf = (key: string): string => /^@agboss\/[^/:]+/u.exec(key)?.[0] ?? key;

/** The tree store's write of a key. */
export const TREE_METHODS: Readonly<Record<string, StoreMethod>> = {
  saveIfAbsentInTree: {
    point: StoreHoldPoint.TreeSaveIfAbsent,
    keyOf: (args) => treeKeyFamilyOf(String(args[1])),
    inputOf: (args) => {
      const { tenantId, rootExecutionId } = args[0] as ExecutionTree;
      return { tenantId, rootExecutionId, family: treeKeyFamilyOf(String(args[1])) };
    },
    outputOf: (saved) => ({ saved }),
  },
};
