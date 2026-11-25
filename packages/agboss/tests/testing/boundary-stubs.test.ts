/**
 * #1328b: `mockRag` and `mockA2A` — the one call of a knowledge base or an A2A peer that leaves the
 * process is scripted; the class stays the container's. A call with nothing scripted fails the test, a
 * script no call took too.
 */
import { describe, expect, it } from "vitest";
import { TestMocks } from "../../src/testing/test-mocks.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { TestFailure, TestSetupError } from "../../src/testing/errors.js";
import { usd } from "../../src/units/index.js";
import { Handbook } from "../rag/fixture.js";
import { BillingDeskA2AAgent, OracleA2AAgent } from "../a2a/fixtures/contracts.workflow.js";

/** The mocks of a test whose application uses these classes. */
function mocksOf(...used: Parameters<typeof usedOf>) {
  const book = new ScriptBook();
  return { book, mocks: new TestMocks(book, [], usedOf(...used)) };
}
const usedOf = (...classes: (new () => unknown)[]): ReadonlySet<new () => unknown> =>
  new Set(classes);

/** What the container does with each instance it creates. */
const created = <T extends object>(mocks: TestMocks, instance: T): T => {
  mocks.container.onCreate?.(instance);
  return instance;
};

describe("#1328b: mockRag", () => {
  it("answers each retrieve with the next scripted retrieval and records the queries", async () => {
    const { mocks } = mocksOf(Handbook);
    const stub = mocks
      .mockRag(Handbook)
      .thenReturn({ results: [{ source: "a.md", text: "A" }], costUsd: usd(0.5) });
    const handbook: { retrieve(query: string): Promise<unknown> } = created(
      mocks,
      new Handbook(),
    ) as never;

    await expect(handbook.retrieve("leave?")).resolves.toEqual({
      results: [{ source: "a.md", text: "A" }],
      costUsd: 0.5,
    });
    expect(stub.calls).toEqual(["leave?"]);
  });

  it("a failure is thrown in its turn; a call with nothing left fails the test", async () => {
    const { book, mocks } = mocksOf(Handbook);
    mocks.mockRag(Handbook).thenFail(new Error("index down"));
    const handbook: { retrieve(query: string): Promise<unknown> } = created(
      mocks,
      new Handbook(),
    ) as never;

    await expect(handbook.retrieve("a")).rejects.toThrow("index down");
    await expect(handbook.retrieve("b")).rejects.toMatchObject({ code: "test.script-exhausted" });
    expect(book.takeFailure()).toBeInstanceOf(TestFailure);
  });

  it("a script no call took fails the test at its end; reset forgets it", () => {
    const { book, mocks } = mocksOf(Handbook);
    const stub = mocks.mockRag(Handbook).thenReturn({ results: [] });

    expect(book.leftoverFailure()?.message).toContain("mockRag(Handbook): 1 scripted step(s)");

    stub.reset();
    expect(book.leftoverFailure()).toBeUndefined();
  });

  it("a class that is no knowledge base, or not of the application, or after the start, is a setup error", () => {
    const { mocks } = mocksOf(Handbook);

    expect(() => mocks.mockRag(BillingDeskA2AAgent)).toThrow(TestSetupError);
    expect(() => mocks.mockRag(OracleA2AAgent)).toThrow(
      /not a @?.*component|not a knowledge base/u,
    );
    mocks.started();
    expect(() => mocks.mockRag(Handbook)).toThrow(/after the app started/u);
  });
});

describe("#1328b: mockA2A", () => {
  it("answers execute and send with the scripted results, in order", async () => {
    const { mocks } = mocksOf(BillingDeskA2AAgent);
    const stub = mocks
      .mockA2A(BillingDeskA2AAgent)
      .thenReturn({ answer: "paid" }, { answer: "due" });
    const agent: {
      execute(input: unknown): Promise<unknown>;
      send(message: string): Promise<unknown>;
    } = created(mocks, new BillingDeskA2AAgent());

    await expect(agent.execute({ question: "invoice 7?" })).resolves.toEqual({ answer: "paid" });
    await expect(agent.send("invoice 8?")).resolves.toEqual({ answer: "due" });
    expect(stub.calls).toEqual([{ question: "invoice 7?" }, "invoice 8?"]);
  });

  it("only an @A2AAgent of the application", () => {
    const { mocks } = mocksOf(BillingDeskA2AAgent);

    expect(() => mocks.mockA2A(OracleA2AAgent)).toThrow(/not an A2A agent of this application/u);
    expect(() => mocks.mockA2A(Handbook)).toThrow(/not an A2A agent/u);
  });
});
