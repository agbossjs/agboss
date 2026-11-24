import { usd } from "../../src/units/index.js";
/**
 * #1366: the spend a PII refusal carries — a block rule that refuses a request, a final answer or a tool call's
 * arguments names every paid detection that led to it (the loop's own, the call's, each text searched), so the
 * failed step's usage records and the ledger agree.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { maskedRequest, outgoingMove } from "../../src/graph/agent-loop/model-pii.js";
import { argumentsRefusal } from "../../src/graph/agent-loop/tool-pii.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

/** A set whose every search costs a record named after the text and finds a blocked value; refusals are noted. */
function blocking() {
  const refusals: (readonly UsageRecord[])[] = [];
  const set = {
    isEmpty: false,
    maskCacheKeyOf: (text: string) => text,
    mask: (text: string) =>
      Promise.resolve({
        masked: { text, blocked: [{ kind: "card", start: 0, end: 1 }], tokens: {} },
        usage: [record(0.125, `detect:${text}`)],
      }),
    refusalError: (_blocked: unknown, usage: readonly UsageRecord[]) => {
      refusals.push(usage);
      return Promise.resolve(new Error("refused"));
    },
  };
  return { set: set as never, refusals };
}

const callers = (records: readonly UsageRecord[] | undefined): string[] | undefined =>
  records?.map((each) => each.caller);

const deps = (set: unknown) =>
  ({
    pii: { withValues: () => ({ withFieldKey: () => set }) },
    agent: { name: "alpha", instructions: "act", answerTools: { tools: [] } },
  }) as never;

const stateOf = (messages: readonly unknown[] = []) =>
  ({
    piiTokens: {},
    piiValues: [],
    piiKey: null,
    piiMasked: {},
    invalidAnswers: 0,
    messages,
    usage: [record(0.25, "before the loop"), record(0.5, "in the loop")],
    from: { usage: 1 },
  }) as never;

describe("#1366: the usage of a refusal", () => {
  it("a refused request names the loop's spend and the detection of each message", async () => {
    const { set, refusals } = blocking();

    await expect(maskedRequest(stateOf(), deps(set))).rejects.toThrow("refused");

    expect(refusals.map(callers)).toEqual([["in the loop", "detect:act"]]);
  });

  it("a refused final answer names the loop's spend, the call's and the detection of each text", async () => {
    const { set, refusals } = blocking();
    const request = { messages: [], tokens: {}, cache: {}, blocked: [], usage: [] };

    await expect(
      outgoingMove(new AIMessage({ content: "done" }), request, stateOf(), deps(set), [
        record(1, "the call"),
      ]),
    ).rejects.toThrow("refused");

    expect(refusals.map(callers)).toEqual([["in the loop", "the call", "detect:done"]]);
  });

  it("refused tool arguments name the detection of each string, and carry it on the result", async () => {
    const { set, refusals } = blocking();

    const refusal = await argumentsRefusal(set, { to: "a", cc: ["b"] });

    expect(refusals.map(callers)).toEqual([["detect:a", "detect:b"]]);
    expect(callers(refusal.usage)).toEqual(["detect:a", "detect:b"]);
  });
});
