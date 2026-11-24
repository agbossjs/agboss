import { effectivePoolOf } from "../a2a/files/a2a-file-slots.js";
import type { FileFetchPool } from "./file-policy.js";

/**
 * How a child's own pool exceeds its parent's, field by field on the numbers each really runs with
 * (the defaults filled in). A child with no pool of its own runs in its parent's. Under the
 * application's shared pool a child's own one is a second pool next to it, so it must be strictly smaller.
 */
export function poolExcessOf(
  parent: FileFetchPool | undefined,
  child: FileFetchPool | undefined,
): readonly string[] {
  if (child === undefined) return [];
  const above = effectivePoolOf(parent ?? {});
  const own = effectivePoolOf(child);
  const names = {
    total: "maxConcurrent",
    tenant: "maxConcurrentPerTenant",
    owner: "maxConcurrentPerOwner",
    queued: "maxQueuedPerOwner",
  } as const;
  const fields = (Object.keys(names) as (keyof typeof names)[]).filter(
    (field) => own[field] > above[field],
  );
  const problems = fields.map(
    (field) => `fetchPool.${names[field]} ${String(own[field])} is above ${String(above[field])}`,
  );
  const smaller = (Object.keys(names) as (keyof typeof names)[]).some(
    (field) => own[field] < above[field],
  );
  return parent === undefined && problems.length === 0 && !smaller
    ? [
        "fetchPool is a second pool beside the application's shared one: make it smaller, or leave it out",
      ]
    : problems;
}
