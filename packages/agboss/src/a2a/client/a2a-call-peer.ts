import type { AgentCard } from "@a2a-js/sdk";
import { millisecondsOf } from "../../mesh/mesh-durations.js";
import { minutes, type Milliseconds } from "../../units/index.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { A2APeerKind, cardExtensionsOf, type A2ARemotePeer } from "./a2a-card.js";

/**
 * The peer one call relies on (#860, design §4.3.3): an AGBoss agent's skill that answers with a
 * direct message (the card's skills extension says `reply: "message"`) deduplicates a `messageId`
 * only as long as it keeps the reply — its mesh extension's `messageIdempotencyRetention`, else
 * the 15 minutes AGBoss keeps one by default — never the task skills' `idempotencyRetention`. So an
 * ambiguous send to it is resent with the same id within that retention only, and past it fails
 * closed (`OutboundCallUnreconciledError`). A task skill, a foreign agent: the card's peer as it is.
 */

/** What AGBoss keeps a direct reply for when its card does not say (`retention.a2aMessages`). */
export const DEFAULT_MESSAGE_RETENTION: Milliseconds = minutes(15);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The params of the card's entry for `uri`; `{}` without them. */
const paramsOf = (card: AgentCard, uri: string): Readonly<Record<string, unknown>> => {
  const params = cardExtensionsOf(card).find((entry) => entry.uri === uri)?.params;
  return isRecord(params) ? params : {};
};

/** Whether the card says the skill answers with a direct message (its only one, when unnamed). */
function isMessageSkill(card: AgentCard, skill: string | undefined): boolean {
  const declared = paramsOf(card, A2A_SKILLS_EXTENSION).skills;
  if (!isRecord(declared)) return false;
  const ids = card.skills.map((each) => each.id);
  const named = skill ?? (ids.length === 1 ? ids[0] : undefined);
  const entry = named === undefined ? undefined : declared[named];
  return isRecord(entry) && entry.reply === "message";
}

/** The message retention an AGBoss card declares; the default when it declares none valid. */
function messageRetentionOf(card: AgentCard): Milliseconds {
  const declared = paramsOf(card, A2A_MESH_EXTENSION).messageIdempotencyRetention;
  const retention = typeof declared === "string" ? millisecondsOf(declared) : undefined;
  return retention === undefined || retention <= 0 ? DEFAULT_MESSAGE_RETENTION : retention;
}

/** The peer a call to `skill` relies on. */
export function callPeerOf(
  card: AgentCard,
  peer: A2ARemotePeer,
  skill: string | undefined,
): A2ARemotePeer {
  if (peer.kind !== A2APeerKind.AGBoss || !isMessageSkill(card, skill)) return peer;
  return { ...peer, idempotencyRetention: messageRetentionOf(card) };
}
