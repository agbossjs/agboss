/**
 * #1366: the model boundary masks what it must and reveals what it must: tokens introduced earlier in a
 * request are known to the later texts, a blocked incoming text is searched again each time, an empty set
 * masks nothing, a move's content and invalid calls are revealed in every shape, a refusal throws, and the
 * reading of an agent is the one set around the work.
 */
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import {
  maskForModel,
  maskedModelText,
  modelReadingMaskOf,
  modelReadingNow,
  revealFromModel,
  withModelReading,
  type ModelReadingMask,
} from "../../src/pii/model-boundary.js";
import type { PiiPolicySet } from "../../src/pii/policy-set.js";

interface Search {
  readonly text: string;
  readonly known: Record<string, string>;
}

/** A set that tokenises each text into `<t:text>`, may report it blocked, and records what each search knew. */
function recording(options: { blocked?: boolean; isEmpty?: boolean; refusal?: Error } = {}) {
  const searches: Search[] = [];
  const set = {
    isEmpty: options.isEmpty ?? false,
    maskCacheKeyOf: (text: string, isIncoming: boolean) => `${isIncoming ? "in" : "out"}:${text}`,
    mask: (text: string, known: Record<string, string>) => {
      searches.push({ text, known: { ...known } });
      return Promise.resolve({
        masked: {
          text: `<${text}>`,
          tokens: { [`<${text}>`]: text },
          blocked: options.blocked === true ? [{ kind: "k" }] : [],
        },
        usage: [],
      });
    },
    refusalError: () => Promise.resolve(options.refusal),
  };
  return { set: set as never, searches };
}

describe("#1366: the masking of a request", () => {
  it("a text is searched knowing the tokens of the execution and of the texts before it", async () => {
    const { set, searches } = recording();

    const masked = await maskForModel(
      set,
      [new HumanMessage("first"), new HumanMessage("second")],
      { "<old>": "old" },
    );

    expect(searches[0]?.known).toEqual({ "<old>": "old" });
    expect(searches[1]?.known).toEqual({ "<old>": "old", "<first>": "first" });
    expect(masked.tokens).toEqual({ "<first>": "first", "<second>": "second" });
  });

  it("an incoming text with a blocked value is searched again every time it comes, and reported each time", async () => {
    const { set, searches } = recording({ blocked: true });

    const masked = await maskForModel(
      set,
      [new HumanMessage("card"), new HumanMessage("card")],
      {},
    );

    expect(searches).toHaveLength(2);
    expect(masked.blocked).toHaveLength(2);
    expect(Object.keys(masked.cache)).toEqual([]);
  });

  it("a text the model said is searched once even when a value in it is blocked, and kept in the cache", async () => {
    const { set, searches } = recording({ blocked: true });
    const said = (): BaseMessage => new AIMessage("card");

    const masked = await maskForModel(set, [said(), said()], {});

    expect(searches).toHaveLength(1);
    expect(masked.blocked).toEqual([]);
    expect(masked.cache).toEqual({ "out:card": "<card>" });
  });

  it("an incoming text without a blocked value is searched once and kept in the cache", async () => {
    const { set, searches } = recording();

    const masked = await maskForModel(
      set,
      [new HumanMessage("plain"), new HumanMessage("plain")],
      {},
    );

    expect(searches).toHaveLength(1);
    expect(masked.cache).toEqual({ "in:plain": "<plain>" });
  });

  it("an empty set passes the very messages through and searches nothing", async () => {
    const { set, searches } = recording({ isEmpty: true });
    const messages = [new HumanMessage("x")];

    const masked = await maskForModel(set, messages, {});

    expect(masked.messages).toBe(messages);
    expect(searches).toEqual([]);
    expect(masked).toMatchObject({ tokens: {}, cache: {}, blocked: [], usage: [] });
  });
});

describe("#1366: a model's move revealed", () => {
  const tokens = { "<name:abc123>": "alice" };

  it("a move without tool calls or invalid calls (as a plain object) comes back with none", () => {
    const plain = { content: "hi <name:abc123>" } as never;

    const { move } = revealFromModel(plain, tokens);

    expect(move.content).toBe("hi alice");
    expect(move.tool_calls).toEqual([]);
    expect(move.invalid_tool_calls).toEqual([]);
  });

  it("a text content is revealed", () => {
    const { move, unknownTokens } = revealFromModel(
      new AIMessage("hi <name:abc123> and <name:def456>"),
      tokens,
    );

    expect(move.content).toBe("hi alice and <name:def456>");
    expect(unknownTokens).toEqual(["<name:def456>"]);
  });

  it("a content of blocks is revealed in each text block", () => {
    const content = [{ type: "text" as const, text: "to <name:abc123>" }];

    const { move } = revealFromModel(new AIMessage({ content }), tokens);

    expect(move.content).toEqual([{ type: "text", text: "to alice" }]);
  });

  it("an invalid call's arguments are revealed; one with no arguments is kept as it is", () => {
    const move = new AIMessage({
      content: "",
      invalid_tool_calls: [
        { name: "t", args: "{ <name:abc123> ", id: "1", error: "bad", type: "invalid_tool_call" },
        { name: "t", args: undefined, id: "2", error: "bad", type: "invalid_tool_call" },
      ],
    });

    const revealed = revealFromModel(move, tokens);

    expect(revealed.move.invalid_tool_calls).toEqual([
      { name: "t", args: "{ alice ", id: "1", error: "bad", type: "invalid_tool_call" },
      { name: "t", args: undefined, id: "2", error: "bad", type: "invalid_tool_call" },
    ]);
  });
});

describe("#1366: a text a model reads", () => {
  it("a refusal for a blocked value throws it before anything is returned", async () => {
    const refusal = new Error("refused");
    const { set } = recording({ blocked: true, refusal });

    const outcome = await maskedModelText(set, "card", {}).catch((error: unknown) => error);

    expect(outcome).toBe(refusal);
  });

  it("without a refusal the masked text, its tokens and its spend come back", async () => {
    const { set } = recording();

    expect(await maskedModelText(set, "plain", {})).toEqual({
      text: "<plain>",
      tokens: { "<plain>": "plain" },
      usage: [],
    });
  });
});

describe("#1366: the reading of the agent whose work runs", () => {
  const mask: ModelReadingMask = (texts) => Promise.resolve({ texts, tokens: {}, usage: [] });

  it("work run with a reading sees it, and its result is returned; outside any work there is none", async () => {
    const seen = vi.fn(() => Promise.resolve(modelReadingNow()));

    const result = await withModelReading(mask, seen);

    expect(result).toBe(mask);
    expect(modelReadingNow()).toBeUndefined();
    expect(modelReadingMaskOf(undefined)).toBeUndefined();
  });
});
