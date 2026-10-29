import { expect } from "vitest";
import { ExecutionContextUnavailableError } from "../../flow/context/errors.js";
import type {
  ExecutionTree,
  ExecutionTreeRepository,
} from "../../infrastructure/execution-tree.repository.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./seam.js";

const tree: ExecutionTree = { tenantId: "default", rootExecutionId: "root-1" };
const otherRequest: ExecutionTree = { tenantId: "default", rootExecutionId: "root-2" };

const TREE_CASES: readonly ContractCase<ExecutionTreeRepository>[] = [
  {
    name: "one true of two: two concurrent saves of one key, on two instances",
    run: async ({ first, second }) => {
      const claimed = await Promise.all([
        first.saveIfAbsentInTree(tree, "subtopic:7", true),
        second.saveIfAbsentInTree(tree, "subtopic:7", true),
      ]);

      expect(claimed.filter(Boolean)).toHaveLength(1);
    },
  },
  {
    name: "visible to the tree on any instance, invisible to other requests",
    run: async ({ first, second }) => {
      await first.saveIfAbsentInTree(tree, "subtopic:7", { by: "researcher" });

      expect(await second.findByIdInTree(tree, "subtopic:7")).toEqual({ by: "researcher" });
      expect(await second.findByIdInTree(otherRequest, "subtopic:7")).toBeUndefined();
      expect(await second.saveIfAbsentInTree(otherRequest, "subtopic:7", true)).toBe(true);
    },
  },
  {
    name: "removed at the end: deleting the tree removes its keys only",
    run: async ({ first, second }) => {
      await first.saveIfAbsentInTree(tree, "subtopic:7", true);
      await first.saveIfAbsentInTree(otherRequest, "subtopic:7", true);

      await second.deleteAllInTree(tree);

      expect(await first.findByIdInTree(tree, "subtopic:7")).toBeUndefined();
      expect(await first.findByIdInTree(otherRequest, "subtopic:7")).toBe(true);
    },
  },
  {
    name: "a value is a copy: changing the saved object changes nothing stored",
    run: async ({ first }) => {
      const value = { topics: ["a"] };
      await first.saveIfAbsentInTree(tree, "plan", value);

      value.topics.push("b");

      expect(await first.findByIdInTree(tree, "plan")).toEqual({ topics: ["a"] });
    },
  },
  {
    name: "a value comes back as JSON gives it: nested lists, objects, null",
    run: async ({ first, second }) => {
      const value = { plan: ["a", 1, true, null], by: { agent: "researcher" } };

      await first.saveIfAbsentInTree(tree, "plan", value);

      expect(await second.findByIdInTree(tree, "plan")).toEqual(value);
    },
  },
  {
    name: "saveIfAbsent / findById outside an execution throw ExecutionContextUnavailableError",
    run: async ({ first }) => {
      await expect(async () => first.saveIfAbsent("k", true)).rejects.toThrow(
        ExecutionContextUnavailableError,
      );
      await expect(async () => first.findById("k")).rejects.toThrow(
        ExecutionContextUnavailableError,
      );
    },
  },
];

/**
 * `ExecutionTreeRepository` (#265 AC2): `saveIfAbsent` is atomic; the keys of a request are visible
 * to its whole tree on any instance, invisible to other requests, removed when the tree ends; a
 * value is stored as JSON, a copy.
 */
export function executionTreeContract(target: ContractTarget<ExecutionTreeRepository>): void {
  registerContract("execution tree contract", target, [{ cases: TREE_CASES }], pingOf);
}
