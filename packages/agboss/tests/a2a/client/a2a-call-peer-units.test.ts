/**
 * #860 (mutation shard `a2a-direct`): how a card's direct-reply skill and its message retention are
 * read — a card without capabilities, without the skills extension or its skills, skills given as a
 * list, a call that names no skill of a card of two; a retention that is no text, no duration, zero:
 * the default 15 min.
 */
import type { AgentCard } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { A2APeerKind, type A2ARemotePeer } from "../../../src/a2a/client/a2a-card.js";
import { callPeerOf, DEFAULT_MESSAGE_RETENTION } from "../../../src/a2a/client/a2a-call-peer.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../../../src/a2a/a2a-extension-uris.js";
import { hours, seconds } from "../../../src/units/index.js";

const PEER: A2ARemotePeer = {
  kind: A2APeerKind.AGBoss,
  idempotencyRetention: hours(24),
  mesh: true,
};

/** A card of `skills`, its extensions' params as given (`undefined`: none of that uri). */
const cardOf = (options: {
  readonly skills?: readonly string[];
  readonly declared?: unknown;
  readonly retention?: unknown;
  readonly capabilities?: false;
}): AgentCard => {
  const extensions = [
    ...(options.declared === undefined
      ? []
      : [{ uri: A2A_SKILLS_EXTENSION, params: options.declared }]),
    ...(options.retention === undefined
      ? []
      : [{ uri: A2A_MESH_EXTENSION, params: { messageIdempotencyRetention: options.retention } }]),
  ];
  return {
    skills: (options.skills ?? ["ask"]).map((id) => ({ id })),
    ...(options.capabilities === false ? {} : { capabilities: { extensions } }),
  } as unknown as AgentCard;
};

const MESSAGE = { skills: { ask: { reply: "message" } } };
const retentionOf = (card: AgentCard, skill?: string) =>
  callPeerOf(card, PEER, skill).idempotencyRetention;

describe("#860: whether a card's skill answers with a direct message", () => {
  it("not for a card without capabilities, without the skills extension, of no params, or one that lists no skills", () => {
    expect([
      retentionOf(cardOf({ capabilities: false }), "ask"),
      retentionOf(cardOf({}), "ask"),
      retentionOf(cardOf({ declared: {} }), "ask"),
      retentionOf(cardOf({ declared: null }), "ask"),
    ]).toEqual([hours(24), hours(24), hours(24), hours(24)]);
  });

  it("not for skills given as a list: they name no skill", () => {
    const card = cardOf({ skills: ["0"], declared: { skills: [{ reply: "message" }] } });

    expect(retentionOf(card, "0")).toBe(hours(24));
  });

  it("not for a call that names no skill of a card of two, whatever their names", () => {
    const declared = { skills: { undefined: { reply: "message" }, ask: { reply: "message" } } };
    const card = cardOf({ skills: ["ask", "undefined"], declared });

    expect(retentionOf(card)).toBe(hours(24));
  });
});

describe("#860: the message retention a card declares", () => {
  it("a duration's milliseconds", () => {
    expect(retentionOf(cardOf({ declared: MESSAGE, retention: "PT90S" }), "ask")).toBe(seconds(90));
  });

  it("the default for one that is no text, no duration, or zero", () => {
    const defaults = [["PT90S"], 90_000, "90 s", "PT0S"].map((retention) =>
      retentionOf(cardOf({ declared: MESSAGE, retention }), "ask"),
    );

    expect(defaults).toEqual([
      DEFAULT_MESSAGE_RETENTION,
      DEFAULT_MESSAGE_RETENTION,
      DEFAULT_MESSAGE_RETENTION,
      DEFAULT_MESSAGE_RETENTION,
    ]);
  });
});
