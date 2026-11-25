/**
 * #1320 (security): the `X-AGBoss-Mesh` header of an HTTP request between two applications — what a
 * receiver refuses and with which code (never a peer's text), what it admits, and what a client never
 * signs. Each refusal has its own test; the receiver is a settings object, the clock a virtual one.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  InMemoryMeshRequestRepository,
  MeshRequestRepository,
} from "../../src/infrastructure/mesh-request.repository.js";
import { admitMeshHttp } from "../../src/mesh/mesh-http-admission.js";
import { signMeshHttp, verifyMeshHttp } from "../../src/mesh/mesh-http.js";
import type { MeshSettings } from "../../src/mesh/mesh-settings.js";
import { MeshInboundMode } from "../../src/mesh/mesh.decorator.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../../src/mesh/mesh-verification.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { ms, seconds } from "../../src/units/index.js";
import { MESH_DEFAULTS } from "../helpers/mesh-settings.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const SKEW = 30_000;
const TTL = 60_000;
const URL_B = "https://b.example/a2a";

const caller = generateKeyPairSync("ed25519");
const rotated = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");

class OrdersEndpoint {
  readonly kind = "orders";
}
class OtherEndpoint {
  readonly kind = "other";
}

/** The receiver `b`, which knows `a` by the given public keys. */
function receiverOf(
  options: {
    readonly keys?: readonly KeyObject[];
    readonly inboundMode?: MeshInboundMode;
    readonly allowEndpoints?: readonly (typeof OrdersEndpoint)[];
    readonly propagateTenant?: boolean;
    readonly clock?: VirtualClock;
    readonly requests?: () => MeshRequestRepository;
    readonly envelopeTtl?: number;
  } = {},
): MeshSettings {
  const store = new InMemoryMeshRequestRepository(new InMemoryDatabase());
  return {
    ...MESH_DEFAULTS,
    application: "b",
    maxMeshHops: 8,
    keys: { peers: new Map([["a", options.keys ?? [caller.publicKey]]]) },
    clock: options.clock ?? new VirtualClock(NOW),
    inboundMode: options.inboundMode ?? MeshInboundMode.Strict,
    envelopeTtl: options.envelopeTtl ?? TTL,
    maxClockSkew: SKEW,
    peers: new Map([
      [
        "a",
        {
          allowEndpoints: options.allowEndpoints,
          propagateTenant: options.propagateTenant === true,
        },
      ],
    ]),
    requests: options.requests ?? (() => store),
    idempotencyRetention: 30 * 60_000,
    workflows: [],
    endpoints: [],
    contracts: () => Promise.reject(new Error("none")),
  };
}

/** The signer `a`: its key, its own clock, the header for one request to `b`. */
function headerOf(
  options: {
    readonly key?: KeyObject;
    readonly clock?: VirtualClock;
    readonly ttl?: number;
    readonly tenantId?: string;
    readonly audience?: string;
    readonly url?: string;
    readonly body?: string;
    readonly method?: string;
  } = {},
): string {
  const header = signMeshHttp(
    {
      application: "a",
      keys: { signingKey: options.key ?? caller.privateKey, peers: new Map() },
      clock: options.clock ?? new VirtualClock(NOW),
      envelopeTtl: options.ttl ?? TTL,
    },
    {
      audience: options.audience ?? "b",
      method: options.method ?? "POST",
      url: options.url ?? URL_B,
      body: options.body ?? '{"x":1}',
      tenantId: options.tenantId,
    },
  );
  if (header === undefined) throw new Error("not signed");
  return header;
}

const received = (
  header: string | undefined,
  over: Partial<Parameters<typeof verifyMeshHttp>[1]> = {},
) => ({
  header,
  method: "POST",
  path: "/a2a",
  body: '{"x":1}',
  origin: "https://b.example",
  ...over,
});

const codeOf = async (settings: MeshSettings, header: string | undefined, over = {}) => {
  const decision = await admitMeshHttp(settings, received(header, over), OrdersEndpoint);
  return decision.kind === "refused" ? decision.code : decision.kind;
};

describe("#1320: a signed request of a peer", () => {
  it("is admitted as the peer, owned by mesh:<peer>", async () => {
    const decision = await admitMeshHttp(receiverOf(), received(headerOf()), OrdersEndpoint);

    expect(decision).toMatchObject({ kind: "peer", peer: "a", ownerId: "mesh:a" });
  });

  it("is refused when no header comes to a Strict endpoint, external when AllowExternal", async () => {
    expect(await codeOf(receiverOf(), undefined)).toBe(MeshRefusalCode.SignatureMissing);
    expect(
      await codeOf(receiverOf({ inboundMode: MeshInboundMode.AllowExternal }), undefined),
    ).toBe("external");
  });

  it("is refused when its signature is no peer's: another key, an unsigned header, a junk header", async () => {
    const unsigned = headerOf().split(".").slice(0, 2).join(".") + ".";

    expect(await codeOf(receiverOf(), headerOf({ key: stranger.privateKey }))).toBe(
      MeshRefusalCode.SignatureInvalid,
    );
    expect(await codeOf(receiverOf(), unsigned)).toBe(MeshRefusalCode.SignatureInvalid);
    expect(await codeOf(receiverOf(), "not a jws")).toBe(MeshRefusalCode.SignatureInvalid);
  });

  it("is refused when its issuer is no listed peer", async () => {
    const settings = receiverOf();
    const noPeers = { ...settings, keys: { peers: new Map<string, KeyObject[]>() } };

    expect(await codeOf(noPeers as MeshSettings, headerOf())).toBe(MeshRefusalCode.PeerUnknown);
  });

  it("during a rotation any listed key verifies, and only those", async () => {
    const both = receiverOf({ keys: [caller.publicKey, rotated.publicKey] });

    expect(await codeOf(both, headerOf({ key: caller.privateKey }))).toBe("peer");
    expect(
      await codeOf(
        receiverOf({ keys: [caller.publicKey, rotated.publicKey] }),
        headerOf({ key: rotated.privateKey }),
      ),
    ).toBe("peer");
    expect(
      await codeOf(
        receiverOf({ keys: [caller.publicKey, rotated.publicKey] }),
        headerOf({ key: stranger.privateKey }),
      ),
    ).toBe(MeshRefusalCode.SignatureInvalid);
    expect(
      await codeOf(receiverOf({ keys: [rotated.publicKey] }), headerOf({ key: caller.privateKey })),
    ).toBe(MeshRefusalCode.SignatureInvalid);
  });

  it("is refused when it has expired, with the clock skew as the only grace", async () => {
    const clock = new VirtualClock(NOW);
    const settings = receiverOf({ clock });
    const header = headerOf();

    await clock.advance(ms(TTL + SKEW));
    expect(await codeOf(settings, header)).toBe("peer");
    const late = receiverOf({ clock });
    await clock.advance(ms(1));
    expect(await codeOf(late, header)).toBe(MeshRefusalCode.EnvelopeExpired);
  });

  it("is refused when dated beyond the skew into the future, admitted at its edge", async () => {
    const ahead = (ms: number) => new VirtualClock(new Date(NOW.getTime() + ms));

    expect(await codeOf(receiverOf(), headerOf({ clock: ahead(SKEW) }))).toBe("peer");
    expect(await codeOf(receiverOf(), headerOf({ clock: ahead(SKEW + 1) }))).toBe(
      MeshRefusalCode.EnvelopeExpired,
    );
  });

  it("is capped by the receiver's envelopeTtl, whatever lifetime it claims", async () => {
    const clock = new VirtualClock(NOW);
    const header = headerOf({ ttl: 24 * 3_600_000 });
    const settings = receiverOf({ clock, envelopeTtl: seconds(10) });

    await clock.advance(ms(seconds(10) + SKEW + 1));

    expect(await codeOf(settings, header)).toBe(MeshRefusalCode.EnvelopeExpired);
  });

  it("is refused for another audience, another origin, another method, path or body", async () => {
    expect(await codeOf(receiverOf(), headerOf({ audience: "c" }))).toBe(
      MeshRefusalCode.AudienceMismatch,
    );
    expect(await codeOf(receiverOf(), headerOf({ url: "https://c.example/a2a" }))).toBe(
      MeshRefusalCode.AudienceMismatch,
    );
    expect(await codeOf(receiverOf(), headerOf(), { method: "GET" })).toBe(
      MeshRefusalCode.RequestMismatch,
    );
    expect(await codeOf(receiverOf(), headerOf(), { path: "/a2a?x=1" })).toBe(
      MeshRefusalCode.RequestMismatch,
    );
    expect(await codeOf(receiverOf(), headerOf(), { body: '{"x":2}' })).toBe(
      MeshRefusalCode.RequestMismatch,
    );
  });

  it("is refused for an endpoint its peer rules do not allow: 403", async () => {
    const settings = receiverOf({ allowEndpoints: [OrdersEndpoint] });

    const decision = await admitMeshHttp(settings, received(headerOf()), OtherEndpoint);

    expect(decision).toEqual({
      kind: "refused",
      status: 403,
      code: MeshRefusalCode.EndpointForbidden,
    });
    expect(await codeOf(receiverOf({ allowEndpoints: [OrdersEndpoint] }), headerOf())).toBe("peer");
  });

  it("carries its tenant only when the peer is trusted with it", async () => {
    const header = headerOf({ tenantId: "t-1" });

    const trusted = await admitMeshHttp(
      receiverOf({ propagateTenant: true }),
      received(header),
      OrdersEndpoint,
    );
    const untrusted = await admitMeshHttp(
      receiverOf(),
      received(headerOf({ tenantId: "t-1" })),
      OrdersEndpoint,
    );

    expect(trusted).toMatchObject({ kind: "peer", tenantId: "t-1" });
    expect(untrusted).toMatchObject({ kind: "peer", tenantId: undefined });
  });
});

describe("#1320: a signed request is admitted once", () => {
  it("the same request sent twice: the second is refused as replayed", async () => {
    const settings = receiverOf();
    const header = headerOf();

    expect(await codeOf(settings, header)).toBe("peer");
    expect(await codeOf(settings, header)).toBe(MeshRefusalCode.Replayed);
  });

  it("two requests of one peer are two ids: both admitted", async () => {
    const settings = receiverOf();

    expect(await codeOf(settings, headerOf())).toBe("peer");
    expect(await codeOf(settings, headerOf())).toBe("peer");
  });

  it("the request is refused, never admitted, when the store is down", async () => {
    const down = {
      saveIfAbsent: () => Promise.reject(new Error("db down")),
    } as never;
    const settings = receiverOf({ requests: () => down });

    const decision = await admitMeshHttp(settings, received(headerOf()), OrdersEndpoint);

    expect(decision).toEqual({
      kind: "refused",
      status: 503,
      code: MeshRefusalCode.ReplayCheckUnavailable,
    });
  });

  it("a refused request leaves nothing in the store: only a verified signature is remembered", async () => {
    const store = new InMemoryMeshRequestRepository(new InMemoryDatabase());
    const settings = receiverOf({ requests: () => store });

    await codeOf(settings, headerOf({ key: stranger.privateKey }));
    await codeOf(settings, headerOf({ audience: "c" }));

    expect(await store.deleteExpired(new Date(NOW.getTime() + 10 * 3_600_000))).toBe(0);
  });

  it("a signature dated at the skew edge cannot be replayed after the sweep's cutoff would have passed it by", async () => {
    const store = new InMemoryMeshRequestRepository(new InMemoryDatabase());
    const clock = new VirtualClock(NOW);
    const settings = receiverOf({ clock, requests: () => store });
    const dedupeTtl = TTL + 2 * SKEW + 60_000; // the least the rules accept
    const issued = new VirtualClock(new Date(NOW.getTime() + SKEW));
    const header = headerOf({ clock: issued });

    expect(await codeOf(settings, header)).toBe("peer");
    // the last moment the signature is valid: issuedAt + envelopeTtl + skew
    const lastValid = NOW.getTime() + SKEW + TTL + SKEW;
    await clock.advance(ms(lastValid - clock.now().getTime()));
    // what the recovery sweep removes at that moment
    await store.deleteExpired(new Date(clock.now().getTime() - dedupeTtl));

    expect(await codeOf(settings, header)).toBe(MeshRefusalCode.Replayed);
  });
});

describe("#1320: a refusal is a code with a fixed text, never a peer's", () => {
  it("every refusal code has its own text with no placeholder", () => {
    for (const code of Object.values(MeshRefusalCode)) {
      expect(MESH_REFUSAL_TEXT[code]).toMatch(/^[a-z]/u);
      expect(MESH_REFUSAL_TEXT[code]).not.toContain("${");
    }
  });
});
