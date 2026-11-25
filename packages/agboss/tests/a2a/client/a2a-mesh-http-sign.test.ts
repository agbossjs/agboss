/**
 * #1320 (security): what an A2A client signs with `X-AGBoss-Mesh` — the request it is made for, to
 * the origin it is made for, and never a hop that leaves it; the mesh's header is the framework's
 * alone (a declared or dynamic header of that name never reaches the wire).
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { originPolicyOf } from "../../../src/a2a/client/a2a-origins.js";
import { wireFetchOf } from "../../../src/a2a/client/a2a-transport.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { readJws } from "../../../src/mesh/mesh-jws.js";
import { rememberContextMeshSettings } from "../../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { testFrame } from "../../helpers/frame.js";
import { MESH_DEFAULTS } from "../../helpers/mesh-settings.js";

const { privateKey } = generateKeyPairSync("ed25519");

interface Seen {
  readonly url: string;
  readonly mesh: string | null;
}

/** A fetcher that records each hop's URL and mesh header, redirecting the first to `redirectTo`. */
function recording(redirectTo: string | undefined): { seen: Seen[]; fetcher: typeof fetch } {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, mesh: new Headers(init?.headers).get("x-agboss-mesh") });
    const isFirst = seen.length === 1;
    return Promise.resolve(
      redirectTo !== undefined && isFirst
        ? new Response(null, { status: 307, headers: { location: redirectTo } })
        : new Response("{}", { status: 200 }),
    );
  };
  return { seen, fetcher };
}

/** Runs one GET of the client in a step of an application that signs with `privateKey`. */
async function getIn(
  fetcher: typeof fetch,
  headers: Record<string, string> = {},
  inFrame = true,
): Promise<void> {
  const frame = testFrame();
  rememberContextMeshSettings(frame.execution.tenant.application, {
    ...MESH_DEFAULTS,
    application: "a",
    keys: { signingKey: privateKey, peers: new Map() },
    clock: new VirtualClock(new Date("2030-01-01T00:00:00.000Z")),
  } as never);
  const policy = originPolicyOf("peer", "https://b.example/a2a", ["https://c.example"]);
  const wire = wireFetchOf(fetcher, () => Promise.resolve(headers), policy, undefined, "b");
  const run = () => wire("https://b.example/a2a/tasks?pageSize=5", { method: "GET" });
  await (inFrame ? runInFrame(frame, run) : run());
}

describe("#1320: the client's X-AGBoss-Mesh header", () => {
  it("signs the request for its audience, its origin and its path with the query", async () => {
    const { seen, fetcher } = recording(undefined);

    await getIn(fetcher);

    const claims = readJws(seen[0]?.mesh)?.payload;
    expect(claims).toMatchObject({
      issuer: "a",
      audience: "b",
      origin: "https://b.example",
      method: "GET",
      path: "/a2a/tasks?pageSize=5",
    });
  });

  it("signs the hop of a redirect on the same origin, never one to another origin", async () => {
    const same = recording("https://b.example/a2a/tasks?pageSize=5&page=2");
    const elsewhere = recording("https://c.example/a2a/tasks");

    await getIn(same.fetcher);
    await getIn(elsewhere.fetcher);

    expect(same.seen.map((hop) => hop.mesh !== null)).toEqual([true, true]);
    expect(elsewhere.seen.map((hop) => [hop.url, hop.mesh !== null])).toEqual([
      ["https://b.example/a2a/tasks?pageSize=5", true],
      ["https://c.example/a2a/tasks", false],
    ]);
  });

  it("is the framework's alone: a header of that name the client sets never reaches the wire", async () => {
    const forged = { "X-AGBoss-Mesh": "forged" };
    const unsigned = recording(undefined);
    const signed = recording(undefined);

    await getIn(unsigned.fetcher, forged, false); // outside a step: nothing to sign with
    await getIn(signed.fetcher, forged);

    expect(unsigned.seen[0]?.mesh).toBeNull();
    expect(signed.seen[0]?.mesh).not.toBe("forged");
    expect(readJws(signed.seen[0]?.mesh)?.signed).toBeDefined();
  });
});
