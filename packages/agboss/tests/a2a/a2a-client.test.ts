import { describe, expect, it, vi } from "vitest";
import {
  A2AAgent,
  A2ACallerRejectedError,
  A2AClient,
  A2ARemoteError,
} from "../../src/a2a/index.js";
import { ComponentError } from "../../src/components/metadata.js";
import { DtoValidationError, Text } from "../../src/dto/index.js";
import { A2AStatus } from "../../src/a2a/types.js";

class Answer {
  @Text()
  text!: string;
}

class Ask {
  @Text()
  text!: string;
}

/** A standalone client's contract (#398 PR 3): the desk's start, its input and output. */
const contract = {
  target: { application: "desk-application", start: "ask-workflow-start" },
  input: Ask,
  output: Answer,
};

const jsonFetch = (body: unknown) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    );

describe("A2AClient", () => {
  it("posts { input, start } to <url>/execute and returns the output validated by the DTO", async () => {
    const fetcher = jsonFetch({ status: A2AStatus.Finished, output: { text: "hi" } });
    const client = new A2AClient<Ask, Answer>({ url: "http://desk", fetcher, contract });

    const result = await client.execute({ text: "q" });

    expect(result).toEqual({ text: "hi" });
    const body = JSON.stringify({ input: { text: "q" }, start: "ask-workflow-start" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://desk/execute",
      expect.objectContaining({ method: "POST", body }),
    );
  });

  it("rejects an input its contract does not accept, before sending (#398 PR 3)", async () => {
    const fetcher = jsonFetch({ status: A2AStatus.Finished, output: { text: "hi" } });
    // a client typed loosely (any object): the DTO checks the value at run time
    const client = new A2AClient({ url: "http://desk", fetcher, contract });

    const sent = client.execute({ text: 42 });

    await expect(sent).rejects.toBeInstanceOf(DtoValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("execute without a contract fails with [a2a.no-contract]; send needs none", async () => {
    const fetcher = jsonFetch({ status: A2AStatus.Finished, output: { text: "hi" } });
    const client = new A2AClient({ url: "http://desk", fetcher });

    await expect(client.execute({})).rejects.toThrow(/\[a2a\.no-contract\]/);
    await expect(client.send({ text: "q" })).resolves.toMatchObject({ output: { text: "hi" } });
  });

  it("rejects an output the DTO does not accept", async () => {
    const fetcher = jsonFetch({ status: A2AStatus.Finished, output: { text: 42 } });

    await expect(
      new A2AClient<Ask, Answer>({ url: "http://desk", fetcher, contract }).execute({ text: "q" }),
    ).rejects.toBeInstanceOf(DtoValidationError);
  });

  it("throws A2ARemoteError for any status but answered", async () => {
    const fetcher = jsonFetch({ status: A2AStatus.Limited, error: "limits.perRun.cost" });

    await expect(
      new A2AClient<Ask, Answer>({ url: "http://desk", fetcher, contract }).execute({ text: "q" }),
    ).rejects.toBeInstanceOf(A2ARemoteError);
  });

  it("passes the abort signal to fetch", async () => {
    const fetcher = jsonFetch({ status: A2AStatus.Finished, output: { text: "" } });
    const ac = new AbortController();

    await new A2AClient({ url: "http://desk", fetcher }).send({ text: "q" }, { signal: ac.signal });

    expect(fetcher).toHaveBeenCalledWith(
      "http://desk/execute",
      expect.objectContaining({ signal: ac.signal }),
    );
  });

  it("#387: sends the thread to continue as threadId", async () => {
    const fetcher = jsonFetch({ status: A2AStatus.Finished, output: { text: "" } });

    await new A2AClient({ url: "http://desk", fetcher }).send({ text: "q" }, { threadId: "t-7" });

    expect(fetcher).toHaveBeenCalledWith(
      "http://desk/execute",
      expect.objectContaining({ body: JSON.stringify({ input: { text: "q" }, threadId: "t-7" }) }),
    );
  });

  it("#387: a 403 carrying an a2a.caller-* code throws A2ACallerRejectedError", async () => {
    const body = { code: "a2a.caller-forbidden", error: "this key may not answer pauses" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 403 }));

    const sent = new A2AClient({ url: "http://desk", fetcher }).send({ text: "q" });

    await expect(sent).rejects.toBeInstanceOf(A2ACallerRejectedError);
    await expect(sent).rejects.toMatchObject({
      httpStatus: 403,
      code: "a2a.caller-forbidden",
      message: expect.stringContaining("this key may not answer pauses") as unknown,
    });
  });

  it("#387: a 401 without a caller code, or a 500, is a plain failed request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "a2a.caller-resolution-failed", error: "x" }), {
          status: 500,
        }),
      );
    const client = new A2AClient({ url: "http://desk", fetcher });

    const unauthorized = client.send({ text: "q" });
    await expect(unauthorized).rejects.toThrow(/failed with status 401/);
    await expect(client.send({ text: "q" })).rejects.not.toBeInstanceOf(A2ACallerRejectedError);
  });

  it("takes its url and contract from @A2AAgent at construction", () => {
    @A2AAgent({ name: "desk-a2a-agent", url: "http://desk.internal", ...contract })
    class DeskA2AAgent extends A2AClient<Ask, Answer> {}

    const client = new DeskA2AAgent();

    expect(client.url).toBe("http://desk.internal");
    expect(client.contract).toEqual(contract);
  });

  it("without @A2AAgent and without a url it fails at construction", () => {
    class Bare extends A2AClient {}

    expect(() => new Bare()).toThrow(ComponentError);
    expect(() => new Bare()).toThrow(/a2a\.no-url/);
  });
});
