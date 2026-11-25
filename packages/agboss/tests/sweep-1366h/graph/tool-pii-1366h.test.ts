/**
 * #1366: the tool task's PII closing — a refused call reads as a refusal (with the refusal's text only when there is
 * one), a result with no PII policies, or an empty set, is kept as rendered, a masked result is kept for the model
 * under the key of its rendered form, and an agent reads through its policies even when its task has no values.
 */
import { describe, expect, it } from "vitest";
import { closedResult, readingAgent, refusedCall } from "../../../src/graph/agent-loop/tool-pii.js";
import { modelReadingNow } from "../../../src/pii/model-boundary.js";
import { renderToolResult } from "../../../src/tools/index.js";
import { kilobytes } from "../../../src/units/index.js";

describe("#1366: tool-pii", () => {
  it("a refused call tells the model it was refused, with the refusal only when there is one", () => {
    expect(refusedCall("")).toBe("Tool error: the call was refused");
    expect(refusedCall("no cards")).toContain("no cards");
    expect(refusedCall("no cards").startsWith("Tool error: the call was refused")).toBe(true);
  });

  it("with no policies a tool's output is kept as rendered, tokens and masks empty", async () => {
    const closed = await closedResult(
      undefined,
      undefined,
      { kind: "ok", value: "fine" },
      kilobytes(1),
    );

    expect(closed.content).toBe(renderToolResult({ kind: "ok", value: "fine" }));
    expect(closed).toMatchObject({ piiTokens: {}, piiMasked: {}, usage: [], isTruncated: false });
  });

  it("a tool with no output type keeps an object result as it is rendered", async () => {
    const closed = await closedResult(
      undefined,
      undefined,
      { kind: "ok", value: { a: 1 } },
      kilobytes(1),
    );

    expect(closed.content).toBe('{"a":1}');
  });

  it("an empty policy set keeps the rendered result and its field tokens without searching it", async () => {
    const closed = await closedResult(
      { isEmpty: true, fieldKey: "k", previous: {} } as never,
      undefined,
      { kind: "ok", value: "fine" },
      kilobytes(1),
    );

    expect(closed.content).toBe(renderToolResult({ kind: "ok", value: "fine" }));
    expect(closed.piiMasked).toEqual({});
    expect(closed.usage).toEqual([]);
    expect(closed.refusal).toBeUndefined();
  });

  it("a masked result is kept for the model under the key of its rendered form", async () => {
    const seen: [string, boolean | undefined][] = [];
    const set = {
      isEmpty: false,
      fieldKey: "k",
      previous: {},
      maskCacheKeyOf: (text: string, flag?: boolean) => {
        seen.push([text, flag]);
        return `key:${text}:${String(flag)}`;
      },
      mask: () =>
        Promise.resolve({ masked: { text: "MASKED", blocked: [], tokens: { t: "v" } }, usage: [] }),
      refusalError: () => Promise.resolve(undefined),
    };

    const closed = await closedResult(
      set as never,
      undefined,
      { kind: "ok", value: "fine" },
      kilobytes(1),
    );

    const rendered = renderToolResult({ kind: "ok", value: "fine" });
    expect(closed.content).toBe(rendered);
    expect(closed.piiMasked).toEqual({ [`key:${rendered}:true`]: "MASKED" });
    expect(closed.piiTokens).toEqual({ t: "v" });
    expect(seen).toEqual([[rendered, true]]);
  });

  it("an agent reads through its policies when its task has no sensitive values", async () => {
    const given: unknown[] = [];
    const set = {
      isEmpty: true,
      withValues(values: unknown) {
        given.push(values);
        return this;
      },
      withFieldKey() {
        return this;
      },
    };

    const result = await readingAgent({ pii: set as never }, {} as never, () =>
      Promise.resolve(modelReadingNow()),
    );

    expect(given).toEqual([[]]);
    expect(result).toBeUndefined();
  });
});
