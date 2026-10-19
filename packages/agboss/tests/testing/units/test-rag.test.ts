/** #262 PR 3 (S89, S95): `testRag` — a knowledge base on its own: results, cost, topK, signal. */
import { describe, expect, it } from "vitest";
import { override, testRag } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import {
  FakeJobBoardService,
  HandbookRag,
  JobBoardService,
  SlowJobBoardService,
} from "../fixtures/units.js";

describe("testRag", () => {
  it("retrieves on its replaced service: the results, its cost as rag:<name>", async () => {
    const search = testRag(HandbookRag, {
      overrides: [override(JobBoardService, FakeJobBoardService)],
    });

    const { output, spend } = await search("remote");

    expect(output).toEqual([
      { source: "handbook#1", text: "remote engineer" },
      { source: "handbook#2", text: "remote lead" },
    ]);
    expect(spend.byCaller).toEqual({ "rag:handbook": 0.001 });
  });

  it("topK asks for fewer results than its @Rag default", async () => {
    const search = testRag(HandbookRag, {
      overrides: [override(JobBoardService, FakeJobBoardService)],
    });

    const { output } = await search("remote", { topK: 1 });

    expect(output).toHaveLength(1);
  });

  it("a timeout aborts the retrieval's signal", async () => {
    const search = testRag(HandbookRag, {
      overrides: [override(JobBoardService, SlowJobBoardService)],
    });

    const failed = expect(search("remote", { timeout: seconds(3) })).rejects.toThrow(
      "aborted due to timeout",
    );
    await search.clock.advance(seconds(3));

    await failed;
  });

  it("a class that is no @Rag is a setup error", () => {
    // @ts-expect-error — a class without retrieve(…) is no knowledge base
    expect(() => testRag(JobBoardService)).toThrow("is not a @Rag component");
  });
});
