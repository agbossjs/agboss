import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryMeshRequestRepository } from "../../src/infrastructure/mesh-request.repository.js";
import type { MeshSettings } from "../../src/mesh/mesh-settings.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";

/** The mesh settings a unit test does not care about (#1320): admit anyone, the defaults of the windows, an own store. */
export const MESH_DEFAULTS: Pick<
  MeshSettings,
  | "inboundMode"
  | "envelopeTtl"
  | "maxClockSkew"
  | "idempotencyRetention"
  | "peers"
  | "isBaseTenantContext"
  | "requests"
> = {
  inboundMode: MeshInboundMode.AllowExternal,
  envelopeTtl: 60_000,
  maxClockSkew: 30_000,
  idempotencyRetention: 30 * 60_000,
  peers: new Map(),
  isBaseTenantContext: true,
  requests: () => new InMemoryMeshRequestRepository(new InMemoryDatabase()),
};
