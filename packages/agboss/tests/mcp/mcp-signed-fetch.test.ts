/**
 * #1320 (security): the MCP client's signed fetch never leaves the origin it signed for — a redirect to
 * another origin is not followed (the header is not sent there), a redirect on the same origin is
 * followed and signed again for its own URL, and a header of that name the client set is dropped.
 */
import { describe, expect, it } from "vitest";
import { signedFetch } from "../../src/tools/mcp/signed-fetch.js";

interface Seen {
  readonly url: string;
  readonly mesh: string | null;
  readonly redirect: RequestInit["redirect"];
}

function recording(redirects: readonly (string | undefined)[]): {
  seen: Seen[];
  fetcher: typeof fetch;
} {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = (input, init) => {
    seen.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      mesh: new Headers(init?.headers).get("x-agboss-mesh"),
      redirect: init?.redirect,
    });
    const next = redirects[seen.length - 1];
    return Promise.resolve(
      next === undefined
        ? new Response("{}", { status: 200 })
        : new Response(null, { status: 302, headers: { location: next } }),
    );
  };
  return { seen, fetcher };
}

const signer = (request: { url: string }): string => `signed-for:${request.url}`;

describe("#1320: the MCP client's signed fetch", () => {
  it("a 302 to another origin does not carry the header there: it is not followed", async () => {
    const { seen, fetcher } = recording(["https://evil.example/mcp"]);

    const answer = await signedFetch(
      fetcher,
      "https://b.example/mcp",
      { method: "GET" },
      {},
      signer,
    );

    expect(answer.status).toBe(302);
    expect(seen.map((hop) => hop.url)).toEqual(["https://b.example/mcp"]);
    expect(seen.every((hop) => hop.redirect === "manual")).toBe(true);
  });

  it("a redirect on the same origin is followed and signed again for its own URL", async () => {
    const { seen, fetcher } = recording(["/mcp/v2"]);

    await signedFetch(fetcher, "https://b.example/mcp", { method: "GET" }, {}, signer);

    expect(seen.map((hop) => [hop.url, hop.mesh])).toEqual([
      ["https://b.example/mcp", "signed-for:https://b.example/mcp"],
      ["https://b.example/mcp/v2", "signed-for:https://b.example/mcp/v2"],
    ]);
  });

  it("a header of the mesh's name the client declares never reaches the wire", async () => {
    const forged = { "X-AGBoss-Mesh": "forged", authorization: "Bearer t" };
    const unsigned = recording([]);
    const signed = recording([]);

    await signedFetch(
      unsigned.fetcher,
      "https://b.example/mcp",
      { method: "POST" },
      forged,
      undefined,
    );
    await signedFetch(signed.fetcher, "https://b.example/mcp", { method: "POST" }, forged, signer);

    expect(unsigned.seen[0]?.mesh).toBeNull();
    expect(signed.seen[0]?.mesh).toBe("signed-for:https://b.example/mcp");
  });

  it("a POST that is redirected is not repeated, signed or not", async () => {
    const { seen, fetcher } = recording(["/mcp/v2"]);

    const answer = await signedFetch(
      fetcher,
      "https://b.example/mcp",
      { method: "POST", body: "{}" },
      {},
      signer,
    );

    expect(answer.status).toBe(302);
    expect(seen).toHaveLength(1);
  });
});
