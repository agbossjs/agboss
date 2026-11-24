import type { Class } from "../components/injection.js";
import type { AssembledApplication } from "../application/assemble.js";
import type { Milliseconds } from "../units/index.js";
import { DEFAULT_IDEMPOTENCY_RETENTION, DEFAULT_MAX_MESH_HOPS } from "./mesh-defaults.js";
import { meshOf } from "./mesh.decorator.js";

/**
 * `@Application({ mesh })` (#398, #1320), as assembled: the `@Mesh`'s limits (hops, how long an answer
 * is kept), or the defaults of an application with no mesh.
 */
export const meshOptionsOf = (options: {
  readonly mesh?: Class;
  readonly exposes?: readonly Class[];
}): Pick<AssembledApplication, "maxMeshHops" | "meshAnswerRetention" | "mesh" | "exposes"> => {
  const mesh = options.mesh === undefined ? undefined : meshOf(options.mesh);
  return {
    maxMeshHops: mesh?.maxHops ?? DEFAULT_MAX_MESH_HOPS,
    meshAnswerRetention: mesh?.deduplicationTtl ?? (DEFAULT_IDEMPOTENCY_RETENTION as Milliseconds),
    exposes: options.exposes ?? [],
    ...(mesh === undefined ? {} : { mesh }),
  };
};
