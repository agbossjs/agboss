/**
 * #336 AC3: a tool result a model reads is bounded by `maxResultSize` — the tool's own, else
 * `defaults.tools` (application → workflow), else 128 KB — cut before PII masking, with a marker;
 * error results and context-mode knowledge blocks too; `onToolEnd` says whether it was cut.
 */
import type { MessageContent } from "@langchain/core/messages";
import { beforeEach, describe, expect, it } from "vitest";
import { applicationOf } from "../../../src/application/assemble.js";
import { describeWorkflow } from "../../../src/describe/describe-workflow.js";
import { GraphRuleError } from "../../../src/index.js";
import { truncatedResultMarker } from "../../../src/prompts/agents.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import type { ModelScript } from "../../../src/testing/model-script.js";
import { testTool } from "../../../src/testing/units/test-tool.js";
import { execute } from "../../helpers/flow.js";
import {
  BoundedPageApplication,
  BrokenPageTool,
  ContextAgent,
  ContextStart,
  FetchPageTool,
  PageApplication,
  PageReader,
  PageStart,
  ReadNotesTool,
  ResearchAgent,
  ZeroBoundApplication,
  piiReads,
  toolEnds,
} from "./fixtures/result-size.workflow.js";

const MEGABYTE = 1_048_576;
const page = "x".repeat(MEGABYTE);
/** The rendered result of a tool returning the page: `{"text":"xxx…"}`. */
const renderedSize = MEGABYTE + `{"text":""}`.length;

/** A message's content as text (a tool result and an input message are text). */
const textOf = (content: MessageContent | undefined): string =>
  typeof content === "string" ? content : JSON.stringify(content);

/** The last message the agent's model read on its second call: the tool's result. */
function toolMessageOf(script: ModelScript): string {
  const request = script.requests[1];
  if (request?.kind !== "chat") throw new Error("expected a second chat request");
  return textOf(request.messages.at(-1)?.text);
}

beforeEach(() => {
  toolEnds.length = 0;
  piiReads.length = 0;
});

describe("#336 AC3: tool results bounded by maxResultSize", () => {
  const test = testWith(PageApplication);
  const bounded = testWith(BoundedPageApplication);

  test("cut at the built-in 128 KB, with the marker", async ({ app, mockLlm, mockOf }) => {
    mockOf(PageReader).textOf.mockResolvedValue(page);
    mockLlm(ResearchAgent).thenReturn(
      callTool(ReadNotesTool, { url: "https://example.com" }),
      replyWith("Done."),
    );

    await execute(app, PageStart, { text: "summarise example.com" });

    const message = toolMessageOf(mockLlm(ResearchAgent));
    expect(message.endsWith(truncatedResultMarker(renderedSize, 131_072))).toBe(true);
    expect(message).toContain("[result truncated: 1,048,587 bytes, the first 131,072 kept]");
  });

  bounded("the tool's own wins over defaults.tools", async ({ app, mockLlm, mockOf }) => {
    mockOf(PageReader).textOf.mockResolvedValue(page);
    mockLlm(ResearchAgent).thenReturn(
      callTool(FetchPageTool, { url: "https://example.com" }),
      replyWith("Done."),
    );

    await execute(app, PageStart, { text: "summarise example.com" });

    expect(toolMessageOf(mockLlm(ResearchAgent))).toContain("the first 262,144 kept]");
  });

  bounded(
    "a tool without its own reads the application's defaults.tools",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(PageReader).textOf.mockResolvedValue(page);
      mockLlm(ResearchAgent).thenReturn(
        callTool(ReadNotesTool, { url: "https://example.com" }),
        replyWith("Done."),
      );

      await execute(app, PageStart, { text: "summarise example.com" });

      expect(toolMessageOf(mockLlm(ResearchAgent))).toContain("the first 65,536 kept]");
    },
  );

  bounded("an error result is bounded", async ({ app, mockLlm, mockOf }) => {
    mockOf(PageReader).textOf.mockResolvedValue(page);
    mockLlm(ResearchAgent).thenReturn(
      callTool(BrokenPageTool, { url: "https://example.com" }),
      replyWith("Done."),
    );

    await execute(app, PageStart, { text: "summarise example.com" });

    const message = toolMessageOf(mockLlm(ResearchAgent));
    expect(message.startsWith("Tool error: xxx")).toBe(true);
    expect(message).toContain(`bytes, the first 65,536 kept]`);
  });

  test("PII masking reads only the kept part", async ({ app, mockLlm, mockOf }) => {
    mockOf(PageReader).textOf.mockResolvedValue(page);
    mockLlm(ResearchAgent).thenReturn(
      callTool(ReadNotesTool, { url: "https://example.com" }),
      replyWith("Done."),
    );

    await execute(app, PageStart, { text: "summarise example.com" });

    // the result as its model reads it: the kept part only; events and traces: it and the marker
    const lengths = piiReads.map((text) => text.length);
    expect(lengths).toContain(131_072);
    const marker = truncatedResultMarker(renderedSize, 131_072);
    expect(Math.max(...lengths)).toBe(131_072 + marker.length);
  });

  bounded(
    "a knowledge base's context block is bounded by the agent's maxResultSize",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(PageReader).textOf.mockResolvedValue(page);
      mockLlm(ContextAgent).thenReturn(replyWith("Done."));

      await execute(app, ContextStart, { text: "what does the page say?" });

      const request = mockLlm(ContextAgent).requests[0];
      const input = request?.kind === "chat" ? textOf(request.input) : "";
      expect(input).toContain("bytes, the first 65,536 kept]");
      expect(input.length).toBeLessThan(MEGABYTE / 8);
    },
  );

  test("onToolEnd says whether the result was cut", async ({ app, mockLlm, mockOf }) => {
    mockOf(PageReader).textOf.mockResolvedValueOnce(page).mockResolvedValueOnce("a short page");
    mockLlm(ResearchAgent).thenReturn(
      callTool(ReadNotesTool, { url: "https://example.com/long" }),
      callTool(ReadNotesTool, { url: "https://example.com/short" }),
      replyWith("Done."),
    );

    await execute(app, PageStart, { text: "read both" });

    expect(toolEnds.map((event) => event.isResultTruncated)).toEqual([true, false]);
    expect(toolEnds[1]?.update).toBe(`{"text":"a short page"}`);
  });
});

describe("#336 AC3: the bound's settings", () => {
  it("testTool(…).run returns the full output: the bound is the model's", async () => {
    const run = testTool(FetchPageTool);

    const { output } = await run({ url: "https://example.com" });

    expect(output.text).toBe("the page https://example.com");
  });

  it("[tools.max-result-size-invalid]: the tool's own and the workflow's, at once", async () => {
    const error: unknown = await applicationOf(ZeroBoundApplication).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    const codes = error instanceof GraphRuleError ? error.violations.map((v) => v.message) : [];
    expect(codes).toEqual([
      expect.stringContaining("zero-bound-workflow: defaults.tools.maxResultSize is 102.4 bytes"),
      expect.stringContaining("ZeroBoundTool: its maxResultSize is 0 bytes"),
    ]);
  });

  it("agboss describe prints each tool's bound and where it came from", async () => {
    const [workflow] = (await applicationOf(BoundedPageApplication)).workflows;
    if (workflow === undefined) throw new TypeError("the fixture lists one workflow");

    const lines = describeWorkflow(workflow).join("\n");

    expect(lines).toContain("maxResultSize 256 KB (own)");
    expect(lines).toContain("maxResultSize 64 KB (bounded-page-application)");
  });
});
