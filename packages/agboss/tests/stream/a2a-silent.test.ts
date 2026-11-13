/** #1004 AC1: the judge's text is not in the A2A task's artifact chunks. */
import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../src/testing/index.js";
import { A2AJudge, A2AJudgedApplication, A2AWriter, judgedListener } from "./a2a-judged.fixture.js";
import { chunksOf, streamed, viewOf } from "./a2a-view.js";

const test = testWith(A2AJudgedApplication);

describe("#1004: the A2A stream carries the answer only", () => {
  test("AC1: no judge text in the chunks; the output replaces them", async ({
    a2aServer,
    mockLlm,
  }) => {
    mockLlm(A2AWriter).thenReturn(replyWith("Good."));
    mockLlm(A2AJudge).thenReturn(replyWith("PASS judge says"));
    const { url } = await a2aServer(judgedListener);

    const chunks = chunksOf(await streamed(url, "m-judge"));

    expect(mockLlm(A2AJudge).requests).toHaveLength(1);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Good.", "Good."]);
    expect(chunks.map((chunk) => chunk.append)).toEqual([false, false]);
    expect(chunks.at(-1)?.last).toBe(true);
    expect(viewOf(chunks)).toBe("Good.");
  });
});
