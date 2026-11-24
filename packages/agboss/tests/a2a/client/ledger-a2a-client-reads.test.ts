/**
 * #1366 (ledger-a2a-client shard) — what the A2A client does besides a call that charges, each rule on its own over
 * a fake card cache: it is built on its url, agent name, contract and origins (its own, and what it allows), with the
 * fetch it was given — else the platform's — and its headers (the fixed ones, then a subclass's own, which win); the
 * card it reads is the checked one; a task is read and cancelled by id on the agent's SDK client, the call's signal
 * with it only when it has one, and a failure of the read is translated, never the SDK's own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import { A2AClientOperation, A2AProtocolError } from "../../../src/a2a/client/a2a-client-errors.js";
import { CardCache } from "../../../src/a2a/client/a2a-card-cache.js";
import { currentFrame } from "../../../src/flow/context/frame.js";
import { kilobytes } from "../../../src/units/index.js";

const made: { options: Record<string, unknown>; cache: Record<string, unknown> }[] = [];

vi.mock("../../../src/a2a/client/a2a-card-cache.js", () => ({
  CardCache: vi.fn(function (this: Record<string, unknown>, options: Record<string, unknown>) {
    const cache = { wireOf: vi.fn(), fetch: vi.fn(() => Promise.resolve(new Response("bytes"))) };
    made.push({ options, cache });
    Object.assign(this, cache);
  }),
}));
vi.mock("../../../src/flow/context/frame.js", () => ({ currentFrame: vi.fn() }));
vi.mock("../../../src/a2a/client/a2a-download.js", () => ({
  downloadedFile: vi.fn((file: unknown, options: unknown) => Promise.resolve({ file, options })),
}));

const URL_OF_AGENT = "http://agent.test/a2a";
const card = { name: "peer-agent", capabilities: { streaming: false } };

class PeerClient extends A2AClient {}
class TokenClient extends A2AClient {
  protected override getHeaders(): Promise<Record<string, string>> {
    return Promise.resolve({ authorization: "Bearer fresh", own: "yes" });
  }
}

const cacheOf = (index = made.length - 1): (typeof made)[number] => {
  const found = made[index];
  if (found === undefined) throw new Error(`no card cache ${String(index)}`);
  return found;
};

beforeEach(() => {
  made.length = 0;
  vi.mocked(CardCache).mockClear();
  vi.mocked(currentFrame).mockReturnValue(undefined);
});

describe("#1366: the client is built on", () => {
  it("its url, the agent's name, its contract, its origins and the fetch it was given", () => {
    const fetcher = vi.fn() as never;
    const contract = { skill: "ask" } as never;

    const client = new PeerClient({ url: URL_OF_AGENT, fetcher, contract, cardTtl: 5000 as never });

    expect(client.url).toBe(URL_OF_AGENT);
    expect(client.contract).toBe(contract);
    expect(cacheOf().options).toMatchObject({
      url: URL_OF_AGENT,
      agent: "PeerClient",
      contract,
      fetcher,
      ttl: 5000,
      policy: { agent: "PeerClient", origins: ["http://agent.test"] },
    });
  });

  it("allows the origins it is told to, besides its own; with none given it allows its own only", () => {
    new PeerClient({ url: URL_OF_AGENT, allowedOrigins: ["https://files.test"] });
    new PeerClient({ url: URL_OF_AGENT });

    expect(cacheOf(0).options.policy).toEqual({
      agent: "PeerClient",
      origins: ["http://agent.test", "https://files.test"],
    });
    expect(cacheOf(1).options.policy).toEqual({
      agent: "PeerClient",
      origins: ["http://agent.test"],
    });
  });

  it("falls back on the platform's fetch when it is given none", () => {
    new PeerClient({ url: URL_OF_AGENT });

    expect(cacheOf().options.fetcher).toBe(fetch);
  });

  it("sends the fixed headers, then a subclass's own over them", async () => {
    new PeerClient({ url: URL_OF_AGENT, headers: { fixed: "a", authorization: "old" } });
    new TokenClient({ url: URL_OF_AGENT, headers: { fixed: "a", authorization: "old" } });
    new PeerClient({ url: URL_OF_AGENT });

    const headersOf = (index: number) =>
      (cacheOf(index).options.headersOf as () => Promise<Record<string, string>>)();
    expect(await headersOf(0)).toEqual({ fixed: "a", authorization: "old" });
    expect(await headersOf(1)).toEqual({ fixed: "a", authorization: "Bearer fresh", own: "yes" });
    expect(await headersOf(2)).toEqual({});
  });
});

describe("#1366: the card and the tasks a client reads", () => {
  function clientOf() {
    const client = new PeerClient({ url: URL_OF_AGENT });
    const wireOf = cacheOf().cache.wireOf as ReturnType<typeof vi.fn>;
    const sdk = {
      getTask: vi.fn((_request: unknown, _options: unknown): Promise<object> =>
        Promise.resolve({ id: "t-1" }),
      ),
      cancelTask: vi.fn((_request: unknown, _options: unknown): Promise<object> =>
        Promise.resolve({ id: "t-1" }),
      ),
    };
    wireOf.mockResolvedValue({ checked: { card }, client: sdk });
    return { client, wireOf, sdk };
  }

  it("the agent's card is the checked one, read for the call's signal on the clock the system keeps outside an execution", async () => {
    const { client, wireOf } = clientOf();
    const signal = new AbortController().signal;

    expect(await client.agentCard({ signal })).toMatchObject({ name: "peer-agent" });

    expect(wireOf).toHaveBeenCalledOnce();
    const [clock, passed] = wireOf.mock.calls[0] ?? [];
    expect(passed).toBe(signal);
    expect(Math.abs((clock as { now: () => Date }).now().getTime() - Date.now())).toBeLessThan(
      5000,
    );
  });

  it("a task is read by its id, in no tenant, with the call's signal when it has one", async () => {
    const { client, sdk } = clientOf();
    const signal = new AbortController().signal;

    await client.getTask("t-1");
    await client.getTask("t-1", { signal });

    expect(sdk.getTask.mock.calls[0]).toEqual([{ tenant: "", id: "t-1" }, {}]);
    expect(sdk.getTask.mock.calls[1]).toEqual([{ tenant: "", id: "t-1" }, { signal }]);
    expect(Object.keys(sdk.getTask.mock.calls[0]?.[1] as object)).toEqual([]);
  });

  it("a task is cancelled by its id, in no tenant, and the task as the agent answers is what comes back", async () => {
    const { client, sdk } = clientOf();
    sdk.cancelTask.mockResolvedValue({ id: "t-1", contextId: "c-1" });
    const signal = new AbortController().signal;

    const answered = await client.cancel("t-1", { signal });
    await client.cancel("t-2");

    expect(answered).toEqual({ id: "t-1", contextId: "c-1", artifacts: [], history: [] });
    expect(sdk.cancelTask.mock.calls[0]).toEqual([
      { tenant: "", id: "t-1", metadata: undefined },
      { signal },
    ]);
    expect(Object.keys(sdk.cancelTask.mock.calls[0]?.[0] as object)).toContain("metadata");
    expect(sdk.cancelTask.mock.calls[1]).toEqual([
      { tenant: "", id: "t-2", metadata: undefined },
      {},
    ]);
  });

  it("a read that fails is translated to the client's own error, naming the agent and the operation", async () => {
    const { client, sdk } = clientOf();
    sdk.getTask.mockRejectedValue(Object.assign(new Error("rpc"), { code: -32001 }));
    sdk.cancelTask.mockRejectedValue(Object.assign(new Error("rpc"), { code: -32002 }));

    const read = await client.getTask("t-1").catch((error: unknown) => error);
    const cancel = await client.cancel("t-1").catch((error: unknown) => error);

    expect(read).toBeInstanceOf(A2AProtocolError);
    expect(read).toMatchObject({ agent: "PeerClient", operation: A2AClientOperation.GetTask });
    expect(cancel).toMatchObject({ agent: "PeerClient", operation: A2AClientOperation.CancelTask });
  });

  it("a read the call's signal stopped fails with the signal's reason, not the SDK's error", async () => {
    const { client, sdk } = clientOf();
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    sdk.cancelTask.mockRejectedValue(new Error("aborted"));

    const failure = await client
      .cancel("t-1", { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(failure).toBe(controller.signal.reason);
  });

  it("a file by url is downloaded through the client's own fetch, with the options it was given", async () => {
    const { client } = clientOf();
    const file = { url: "http://agent.test/f" } as never;

    const out = await client.downloadFile(file, { maxSize: kilobytes(5) });

    expect(out).toEqual({
      file,
      options: expect.objectContaining({ maxSize: kilobytes(5), fetcher: cacheOf().cache.fetch }),
    });
  });
});
