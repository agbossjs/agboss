import type { AgentCard } from "@a2a-js/sdk";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import type { DtoClass } from "../../dto/types.js";
import { jsonSchemaOf, type JsonSchema } from "../../dto/schema.js";
import { incompatibilitiesOf } from "../../federation/schema-compat.js";
import { millisecondsOf } from "../../mesh/mesh-durations.js";
import type { Milliseconds } from "../../units/index.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import {
  A2AClientOperation,
  A2AContractError,
  A2AContractRule,
  A2AProtocolError,
} from "./a2a-client-errors.js";
import { A2AOriginSite } from "./a2a-guard-errors.js";
import { originRefusalOf, type OriginPolicy } from "./a2a-origins.js";
import { wireErrorOf } from "./a2a-wire-errors.js";

/**
 * Discovery (#809, design §4.2): the agent's card fetched from `<url>/.well-known/agent-card.json`,
 * checked — an A2A 1.0 interface on a binding the client speaks, the named skill, the skill's
 * schemas against the client's DTOs — and read for what the agent guarantees.
 */

/** Who the agent is, as its card says: what the client may rely on. */
export enum A2APeerKind {
  /**
   * An AGBoss application: its card's mesh extension declares how long it deduplicates a
   * `messageId` — an ambiguous send is resent with the same one, within that retention.
   */
  AGBoss = "agboss",
  /** Any other A2A agent: no deduplication is assumed, an ambiguous send is never resent. */
  Foreign = "foreign",
}

/**
 * What the client relies on of the agent it calls (#809, design §4.3.3) — explicit, never assumed:
 * `idempotencyRetention` only for an AGBoss peer, which declares it; `mesh` whether the AGBoss mesh
 * (call chain, budget, deadline, signed spend) rides the call — else the client charges its `price`.
 */
export type A2ARemotePeer =
  | {
      readonly kind: A2APeerKind.AGBoss;
      /** How long the agent deduplicates a `messageId` (its card's declaration). */
      readonly idempotencyRetention: Milliseconds;
      /** Whether the mesh extension is active on the call. */
      readonly mesh: boolean;
    }
  | {
      readonly kind: A2APeerKind.Foreign;
      readonly idempotencyRetention: undefined;
      readonly mesh: boolean;
    };

/** The JSON Schemas an AGBoss peer declares for one skill. */
interface SkillSchemas {
  readonly input: JsonSchema | undefined;
  readonly outputs: Readonly<Record<string, JsonSchema>>;
}

/** A card checked for a client: the card, the peer it describes. */
export interface CheckedCard {
  readonly card: AgentCard;
  readonly peer: A2ARemotePeer;
}

/** What the client declares: its skill, its DTOs. */
export interface CardExpectation {
  readonly agent: string;
  readonly skill: string | undefined;
  readonly input: DtoClass | undefined;
  readonly output: DtoClass | undefined;
}

/** The bindings this client speaks (the SDK's JSON-RPC and HTTP+JSON transports). */
const BINDINGS = new Set(["JSONRPC", "HTTP+JSON"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `<url>/.well-known/agent-card.json` — `url` is the agent's base URL. */
export const cardUrlOf = (url: string): string => `${url.replace(/\/+$/u, "")}/${AGENT_CARD_PATH}`;

/** The A2A versions a raw card declares: each interface's, and a v0.3 card's top-level one. */
function versionsOf(raw: Readonly<Record<string, unknown>>): readonly string[] {
  const interfaces = Array.isArray(raw.supportedInterfaces) ? raw.supportedInterfaces : [];
  const declared = interfaces.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.protocolVersion === "string" ? [entry.protocolVersion] : [],
  );
  const legacy = typeof raw.protocolVersion === "string" ? [raw.protocolVersion] : [];
  return [...new Set([...declared, ...legacy])];
}

/** The URLs of a raw card's A2A 1.x interfaces on a binding this client speaks. */
function usableInterfaceUrlsOf(raw: Readonly<Record<string, unknown>>): readonly string[] {
  const interfaces = Array.isArray(raw.supportedInterfaces) ? raw.supportedInterfaces : [];
  return interfaces.flatMap((entry: unknown) =>
    isRecord(entry) &&
    typeof entry.url === "string" &&
    typeof entry.protocolBinding === "string" &&
    BINDINGS.has(entry.protocolBinding.toUpperCase()) &&
    typeof entry.protocolVersion === "string" &&
    /^1(\.\d+)?$/u.test(entry.protocolVersion.trim())
      ? [entry.url]
      : [],
  );
}

/** The params of the card's entry for an extension, if it declares one. */
function extensionParamsOf(
  card: AgentCard,
  uri: string,
): Readonly<Record<string, unknown>> | undefined {
  const entry = card.capabilities?.extensions.find((extension) => extension.uri === uri);
  if (entry === undefined) return undefined;
  return isRecord(entry.params) ? entry.params : {};
}

/** The peer a card describes: an AGBoss peer only with a valid declared retention. */
export function peerOf(card: AgentCard): A2ARemotePeer {
  const mesh = extensionParamsOf(card, A2A_MESH_EXTENSION);
  const declared = mesh?.idempotencyRetention;
  const retention = typeof declared === "string" ? millisecondsOf(declared) : undefined;
  return retention !== undefined && retention > 0
    ? { kind: A2APeerKind.AGBoss, idempotencyRetention: retention, mesh: false }
    : { kind: A2APeerKind.Foreign, idempotencyRetention: undefined, mesh: false };
}

/**
 * Fetches and checks the card at `url`: a failed answer is `A2AProtocolError` (its status), a card
 * without an A2A 1.0 interface `A2AProtocolError` naming the versions it declares (a v0.3 agent),
 * one with a usable interface outside the client's origins `A2AOriginError`.
 */
export async function fetchCard(
  url: string,
  fetchImpl: typeof fetch,
  policy: OriginPolicy,
  signal?: AbortSignal,
): Promise<CheckedCard> {
  const { agent } = policy;
  const operation = A2AClientOperation.AgentCard;
  let raw: unknown;
  try {
    const response = await fetchImpl(cardUrlOf(url), {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new A2AProtocolError({ agent, operation, httpStatus: response.status });
    }
    raw = await response.json();
  } catch (error) {
    throw wireErrorOf(error, agent, operation, signal);
  }
  if (!isRecord(raw)) throw new A2AProtocolError({ agent, operation });
  const usable = usableInterfaceUrlsOf(raw);
  if (usable.length === 0) {
    throw new A2AProtocolError({ agent, operation, protocolVersions: versionsOf(raw) });
  }
  // #809 security: an interface elsewhere would get the client's headers — the card is refused
  for (const interfaceUrl of usable) {
    const refused = originRefusalOf(policy, interfaceUrl, A2AOriginSite.CardInterface);
    if (refused !== undefined) throw refused;
  }
  const normalized = new DefaultAgentCardResolver().normalizeAgentCard(raw);
  // the SDK picks among the usable interfaces only: never a v0.3 one, never one elsewhere
  const card = {
    ...normalized,
    supportedInterfaces: normalized.supportedInterfaces.filter(
      (each) => usable.includes(each.url) && /^1(\.\d+)?$/u.test(each.protocolVersion.trim()),
    ),
  };
  return { card, peer: peerOf(card) };
}

/** The skill a call names: the declared one, else the card's only skill (none with several). */
export function skillOf(card: AgentCard, expected: CardExpectation): string | undefined {
  if (expected.skill !== undefined) return expected.skill;
  const [only, ...others] = card.skills;
  return only !== undefined && others.length === 0 ? only.id : undefined;
}

/** The schemas an AGBoss peer's skills extension declares for `skill`. */
function skillSchemasOf(card: AgentCard, skill: string): SkillSchemas | undefined {
  const skills = extensionParamsOf(card, A2A_SKILLS_EXTENSION)?.skills;
  const entry = isRecord(skills) ? skills[skill] : undefined;
  if (!isRecord(entry)) return undefined;
  const outputs = isRecord(entry.outputs) ? entry.outputs : {};
  return {
    input: isRecord(entry.input) ? entry.input : undefined,
    outputs: Object.fromEntries(
      Object.entries(outputs).filter((pair): pair is [string, JsonSchema] => isRecord(pair[1])),
    ),
  };
}

/** The differences between a skill's schemas and the client's DTOs (`input: …`, `output (f): …`). */
function differencesOf(schemas: SkillSchemas, expected: CardExpectation): readonly string[] {
  const found: string[] = [];
  if (expected.input !== undefined && schemas.input !== undefined) {
    const sent = jsonSchemaOf(expected.input);
    found.push(...incompatibilitiesOf(schemas.input, sent).map((reason) => `input: ${reason}`));
  }
  if (expected.output !== undefined) {
    const accepted = jsonSchemaOf(expected.output);
    for (const [finish, given] of Object.entries(schemas.outputs)) {
      const reasons = incompatibilitiesOf(accepted, given);
      found.push(...reasons.map((reason) => `output (${finish}): ${reason}`));
    }
  }
  return found;
}

/**
 * Checks a card against what the client declares, before anything is sent: the named skill must be
 * in the card (`[a2a.unknown-skill]`), and — when an AGBoss peer declares the skill's schemas — the
 * skill's input must accept the client's input DTO and the client's output DTO every finish output
 * (`[a2a.schema-mismatch]`). A card without schemas leaves the input to the local check before
 * sending and the output to the check on arrival.
 */
export function checkCard(card: AgentCard, expected: CardExpectation): void {
  const skill = skillOf(card, expected);
  if (skill === undefined) return;
  if (!card.skills.some((declared) => declared.id === skill)) {
    throw new A2AContractError({
      agent: expected.agent,
      rule: A2AContractRule.UnknownSkill,
      skill,
    });
  }
  const schemas = skillSchemasOf(card, skill);
  if (schemas === undefined) return;
  const differences = differencesOf(schemas, expected);
  if (differences.length === 0) return;
  throw new A2AContractError({
    agent: expected.agent,
    rule: A2AContractRule.SchemaMismatch,
    skill,
    differences,
  });
}
