// #1356: a receiver `b` that knows a peer `a`, and the signed `X-AGBoss-Mesh` header `a` sends it — what the
// mutation tests of the mesh's HTTP gates (`tests/mesh/*-mutation.test.ts`) build their requests on.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  InMemoryMeshRequestRepository,
  type MeshRequestRepository,
} from "../../src/infrastructure/mesh-request.repository.js";
import { signMeshHttp } from "../../src/mesh/mesh-http.js";
import type { MeshSettings } from "../../src/mesh/mesh-settings.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { MESH_DEFAULTS } from "./mesh-settings.js";

export const NOW = new Date("2030-01-01T00:00:00.000Z");
export const ORIGIN = "https://b.example";
export const PEER_KEYS = generateKeyPairSync("ed25519");

export class OrdersEndpoint {
  readonly kind = "orders";
}
export class OtherEndpoint {
  readonly kind = "other";
}

export interface ReceiverOptions {
  readonly allowEndpoints?: readonly (new () => object)[] | undefined;
  readonly propagateTenant?: boolean;
  readonly inboundMode?: MeshInboundMode;
  readonly clock?: VirtualClock;
  readonly isBaseTenantContext?: boolean;
  /** The peer is a key holder with no rules: what `@Mesh` never builds. */
  readonly withoutRules?: boolean;
}

/** The receiver `b`, which knows `a` by its public key; the request store it admits into is returned beside. */
export function receiverOf(options: ReceiverOptions = {}): {
  readonly settings: MeshSettings;
  readonly store: MeshRequestRepository;
} {
  const store = new InMemoryMeshRequestRepository(new InMemoryDatabase());
  const settings: MeshSettings = {
    ...MESH_DEFAULTS,
    application: "b",
    maxMeshHops: 8,
    keys: { peers: new Map<string, KeyObject[]>([["a", [PEER_KEYS.publicKey]]]) },
    clock: options.clock ?? new VirtualClock(NOW),
    inboundMode: options.inboundMode ?? MeshInboundMode.Strict,
    envelopeTtl: 60_000,
    maxClockSkew: 30_000,
    isBaseTenantContext: options.isBaseTenantContext ?? true,
    peers:
      options.withoutRules === true
        ? new Map()
        : new Map([
            [
              "a",
              {
                allowEndpoints: options.allowEndpoints,
                propagateTenant: options.propagateTenant === true,
              },
            ],
          ]),
    requests: () => store,
    idempotencyRetention: 30 * 60_000,
    workflows: [],
    endpoints: [],
    contracts: () => Promise.reject(new Error("none")),
  };
  return { settings, store };
}

/** The header peer `a` signs for one request to `b`. */
export function headerOf(
  options: {
    readonly clock?: VirtualClock;
    readonly tenantId?: string;
    readonly url?: string;
    readonly body?: string;
    readonly method?: string;
  } = {},
): string {
  const header = signMeshHttp(
    {
      application: "a",
      keys: { signingKey: PEER_KEYS.privateKey, peers: new Map() },
      clock: options.clock ?? new VirtualClock(NOW),
      envelopeTtl: 60_000,
    },
    {
      audience: "b",
      method: options.method ?? "POST",
      url: options.url ?? `${ORIGIN}/a2a`,
      body: options.body ?? '{"x":1}',
      tenantId: options.tenantId,
    },
  );
  if (header === undefined) throw new Error("not signed");
  return header;
}
