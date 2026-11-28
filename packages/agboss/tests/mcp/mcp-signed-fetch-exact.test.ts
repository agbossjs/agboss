/**
 * #1356 (a2a-client shard): the MCP client's signed fetch, each rule on its own (#1320) — what the signer is asked for,
 * which headers go on, which answers are redirects (300 to 399 with a location), which are followed (a GET on the same
 * origin, three times at most) and what is handed to the fetcher at each hop.
 */
import { describe, expect, it } from "vitest";
import { signedFetch } from "../../src/tools/mcp/signed-fetch.js";

interface Hop {
  readonly input: Parameters<typeof fetch>[0];
  readonly init: RequestInit | undefined;
}

/** A fetcher that answers the n-th request with `answers[n]` (a final 200 after them), and keeps what it was given. */
function answering(answers: readonly Response[] | ((n: number) => Response | undefined) = []) {
  const hops: Hop[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const n = hops.length;
    hops.push({ input, init });
    const next = typeof answers === "function" ? answers(n) : answers[n];
    return Promise.resolve(next ?? new Response("{}", { status: 200 }));
  };
  return { hops, fetcher };
}
const redirect = (status: number, location: string | null = "/next") =>
  new Response(null, {
    status,
    ...(location === null ? {} : { headers: { location } }),
  });
const headersOf = (hop: Hop | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(hop?.init?.headers).entries());
const URL0 = "https://b.example/mcp";

describe("#1356: what the signer is asked to sign", () => {
  it("is the URL, the method as given and the body as given, for each hop", async () => {
    const asked: unknown[] = [];
    const { fetcher } = answering([redirect(302, "/mcp/v2")]);

    await signedFetch(fetcher, URL0, { method: "get", body: "text" }, {}, (request) => {
      asked.push(request);
      return "sig";
    });

    expect(asked).toEqual([
      { url: URL0, method: "get", body: "text" },
      { url: "https://b.example/mcp/v2", method: "get", body: "text" },
    ]);
  });

  it("is a GET without a body when the request has no init, or no method", async () => {
    const asked: unknown[] = [];
    const signer = (request: unknown) => {
      asked.push(request);
      return "sig";
    };

    await signedFetch(answering().fetcher, URL0, undefined, {}, signer);
    await signedFetch(answering().fetcher, URL0, {}, {}, signer);

    expect(asked).toEqual([
      { url: URL0, method: "GET", body: undefined },
      { url: URL0, method: "GET", body: undefined },
    ]);
  });

  it("names a URL given as text, as a URL object, or as a request", async () => {
    const urls: string[] = [];
    const signer = (request: { url: string }) => {
      urls.push(request.url);
      return "sig";
    };

    await signedFetch(answering().fetcher, URL0, undefined, {}, signer);
    await signedFetch(answering().fetcher, new URL(URL0), undefined, {}, signer);
    await signedFetch(answering().fetcher, new Request(URL0), undefined, {}, signer);

    expect(urls).toEqual([URL0, URL0, URL0]);
  });
});

describe("#1356: the headers of a hop", () => {
  it("keep the declared ones and drop the mesh's own, whatever its case, and add the signature", async () => {
    const { hops, fetcher } = answering();

    await signedFetch(
      fetcher,
      URL0,
      { method: "POST" },
      { authorization: "Bearer t", "x-AGBOSS-mesh": "forged", accept: "text/event-stream" },
      () => "sig",
    );

    expect(headersOf(hops[0])).toEqual({
      authorization: "Bearer t",
      accept: "text/event-stream",
      "x-agboss-mesh": "sig",
    });
    expect(hops[0]?.init).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("are the declared ones alone, as they are, when there is nothing to sign", async () => {
    const { hops, fetcher } = answering();

    await signedFetch(
      fetcher,
      URL0,
      { method: "POST", body: "{}" },
      { authorization: "Bearer t", "X-AGBoss-Mesh": "forged" },
      () => undefined,
    );

    expect(hops[0]?.init).toEqual({
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer t" },
    });
  });

  it("hand the fetcher the very input it was given, when nothing is signed", async () => {
    const input = new URL(URL0);
    const { hops, fetcher } = answering();

    await signedFetch(fetcher, input, undefined, {}, undefined);

    expect(hops[0]?.input).toBe(input);
  });

  it("go to the hop's own URL when a later hop is not signed, with the declared headers", async () => {
    const input = new URL(URL0);
    const { hops, fetcher } = answering([redirect(307, "/mcp/v2")]);
    let n = 0;

    await signedFetch(fetcher, input, undefined, { accept: "x" }, () => {
      n += 1;
      return n === 1 ? "sig" : undefined;
    });

    expect(hops.map((hop) => hop.input)).toEqual([URL0, "https://b.example/mcp/v2"]);
    expect(hops[1]?.init).toEqual({ headers: { accept: "x" } });
  });
});

describe("#1356: which answers are followed", () => {
  const followed = async (
    response: Response,
    init: RequestInit | undefined = { method: "GET" },
  ) => {
    const { hops, fetcher } = answering([response]);
    const answer = await signedFetch(fetcher, URL0, init, {}, () => "sig");
    return { hops: hops.length, status: answer.status };
  };

  it.each([300, 301, 302, 307, 308, 399])(
    "a %s with a location on the same origin is",
    async (status) => {
      expect(await followed(redirect(status))).toEqual({ hops: 2, status: 200 });
    },
  );

  it.each([200, 204, 299, 400, 404, 500])(
    "a %s with a location is not a redirect",
    async (status) => {
      const response = new Response(null, { status, headers: { location: "/next" } });

      expect(await followed(response)).toEqual({ hops: 1, status });
    },
  );

  it("a redirect without a location is handed back", async () => {
    expect(await followed(redirect(302, null))).toEqual({ hops: 1, status: 302 });
  });

  it("a GET with no method named, with no init at all, and a get in any case is followed; any other method is not", async () => {
    expect((await followed(redirect(302), {})).hops).toBe(2);
    expect((await followed(redirect(302), undefined)).hops).toBe(2);
    expect((await followed(redirect(302), { method: "get" })).hops).toBe(2);
    expect((await followed(redirect(302), { method: "HEAD" })).hops).toBe(1);
    expect((await followed(redirect(302), { method: "POST" })).hops).toBe(1);
  });

  it("a redirect to another origin, scheme or port is handed back, never followed", async () => {
    for (const location of [
      "https://evil.example/mcp",
      "http://b.example/mcp",
      "https://b.example:8443/mcp",
    ])
      expect(await followed(redirect(302, location))).toEqual({ hops: 1, status: 302 });
  });

  it("a redirect is followed three times at most: the fourth answer is handed back", async () => {
    const { hops, fetcher } = answering(() => redirect(302, "/again"));

    const answer = await signedFetch(fetcher, URL0, { method: "GET" }, {}, () => "sig");

    expect(answer.status).toBe(302);
    expect(hops.map((hop) => hop.input)).toEqual([
      URL0,
      "https://b.example/again",
      "https://b.example/again",
      "https://b.example/again",
    ]);
  });

  it("a relative location is read against the hop it came from", async () => {
    const { hops, fetcher } = answering([redirect(302, "v2/"), redirect(302, "../up")]);

    await signedFetch(fetcher, "https://b.example/a/b", { method: "GET" }, {}, () => "sig");

    expect(hops.map((hop) => hop.input)).toEqual([
      "https://b.example/a/b",
      "https://b.example/a/v2/",
      "https://b.example/a/up",
    ]);
  });
});
